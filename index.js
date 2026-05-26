const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');
const twilio = require('twilio');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const REMINDERS_FILE = './reminders.json';
const BOOKING_CUTOFF_HOUR = 18; // 6:00 PM

const ALL_SLOTS = ['10:00am', '11:00am', '12:00pm', '2:00pm', '3:00pm', '4:00pm', '5:00pm'];

// ─── Slot Utilities ────────────────────────────────────────────────────────────

function slotToMinutes(slot) {
  const isPM = slot.includes('pm');
  const isAM = slot.includes('am');
  const time = slot.replace('am', '').replace('pm', '').trim();
  let [hours, minutes] = time.includes(':') ? time.split(':').map(Number) : [parseInt(time), 0];
  if (isPM && hours !== 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  return hours * 60 + (minutes || 0);
}

function isAfterCutoff() {
  const now = new Date();
  return now.getHours() >= BOOKING_CUTOFF_HOUR;
}

function getBookingDate() {
  const now = new Date();
  if (isAfterCutoff()) {
    // Book for tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow;
  }
  return now;
}

function getAvailableSlotsForToday() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes() + 30; // 30min buffer
  return ALL_SLOTS.filter(slot => slotToMinutes(slot) > currentMinutes);
}

async function getBookedSlotsFromSheet(dateStr) {
  try {
    const response = await axios.get(process.env.GOOGLE_SHEET_URL + '?date=' + encodeURIComponent(dateStr));
    const bookings = response.data;
    if (!Array.isArray(bookings)) return [];
    return bookings
      .filter(b => b.date === dateStr)
      .map(b => b.time.toLowerCase().trim());
  } catch (err) {
    console.error('Could not fetch booked slots:', err.message);
    return [];
  }
}

// Returns the next available slot for the booking date (first-come-first-served)
async function getNextAvailableSlot() {
  const bookingDate = getBookingDate();
  const dateStr = bookingDate.toLocaleDateString('en-IN');
  const bookedSlots = await getBookedSlotsFromSheet(dateStr);

  let candidateSlots = ALL_SLOTS;

  // If booking is for today (not after cutoff), filter past slots
  if (!isAfterCutoff()) {
    candidateSlots = getAvailableSlotsForToday();
  }

  // Return first slot not already booked
  const nextSlot = candidateSlots.find(slot => !bookedSlots.includes(slot.toLowerCase()));
  return { slot: nextSlot || null, dateStr };
}

// ─── Reminder Utilities ────────────────────────────────────────────────────────

function loadAndRescheduleReminders() {
  if (!fs.existsSync(REMINDERS_FILE)) return;
  const reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  const now = Date.now();
  const remaining = [];

  reminders.forEach(r => {
    const delay = r.reminderTime - now;
    if (delay > 0) {
      console.log(`Re-scheduling reminder for ${r.booking.name} in ${Math.round(delay / 60000)} mins`);
      remaining.push(r);
      scheduleReminderAt(r.booking, r.reminderTime);
    } else {
      console.log(`Missed reminder for ${r.booking.name}, skipping`);
    }
  });

  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(remaining));
}

function saveReminder(booking, reminderTime) {
  let reminders = [];
  if (fs.existsSync(REMINDERS_FILE)) {
    reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  }
  reminders.push({ booking, reminderTime });
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders));
}

function removeReminder(phone) {
  if (!fs.existsSync(REMINDERS_FILE)) return;
  let reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  reminders = reminders.filter(r => r.booking.phone !== phone);
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders));
}

function scheduleReminderAt(booking, reminderTime) {
  const delay = reminderTime - Date.now();
  setTimeout(async () => {
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: booking.phone,
        body: `Hi ${booking.name}! 👋 Reminder from ${process.env.BUSINESS_NAME || 'Smart Salon'}.

Your appointment is in 30 minutes!
📋 Service: ${booking.service}
⏰ Time: ${booking.time}
📍 Date: ${booking.date}
📍 City: ${booking.city}

See you soon! 😊`
      });
      console.log(`Reminder sent to ${booking.name}!`);
      removeReminder(booking.phone);
    } catch (err) {
      console.error('Reminder error:', err.message);
    }
  }, delay);
}

function scheduleReminder(booking) {
  try {
    // Parse date from booking (en-IN format: dd/mm/yyyy)
    const [day, month, year] = booking.date.split('/').map(Number);
    const slot = booking.time.toLowerCase();
    const isPM = slot.includes('pm');
    const isAM = slot.includes('am');
    const time = slot.replace('am', '').replace('pm', '').trim();
    let [hours, minutes] = time.includes(':') ? time.split(':').map(Number) : [parseInt(time), 0];
    if (isPM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    const appointmentTime = new Date(year, month - 1, day, hours, minutes || 0, 0, 0);
    const reminderTime = appointmentTime.getTime() - 30 * 60 * 1000;
    const delay = reminderTime - Date.now();

    if (delay <= 0) {
      console.log('Too soon for a 30-min reminder');
      return;
    }

    saveReminder(booking, reminderTime);
    scheduleReminderAt(booking, reminderTime);
    console.log(`Reminder scheduled for ${booking.name} on ${booking.date} at ${booking.time}`);

  } catch (err) {
    console.error('Schedule error:', err.message);
  }
}

// ─── WhatsApp Route ────────────────────────────────────────────────────────────

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMsg });

  // Check cutoff and get next available slot
  const afterCutoff = isAfterCutoff();
  const { slot: assignedSlot, dateStr: bookingDateStr } = await getNextAvailableSlot();

  const bookingDateLabel = afterCutoff ? `tomorrow (${bookingDateStr})` : `today (${bookingDateStr})`;

  let slotInfo = '';
  if (!assignedSlot) {
    slotInfo = `No slots available for ${bookingDateLabel}. Inform the customer politely and ask them to call directly.`;
  } else {
    slotInfo = `Next available slot: ${assignedSlot} on ${bookingDateLabel}. This slot will be automatically assigned to the customer — do NOT ask them to choose a time.`;
  }

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a friendly appointment booking assistant for a salon.
Business name: ${process.env.BUSINESS_NAME || 'Smart Salon'}
Working hours: 10:00am to 5:00pm. Bookings close at 6:00pm each day.

SLOT ASSIGNMENT (IMPORTANT):
${slotInfo}

${afterCutoff ? '⚠️ It is past 6:00 PM. Bookings for today are CLOSED. You are booking for TOMORROW.' : ''}

Services and prices:
- Haircut: Rs 300
- Facial: Rs 500
- Massage: Rs 800
- Cleanup: Rs 400

Your job - follow these steps in order:
1. Greet the customer warmly
2. If it is after 6pm, inform them today's bookings are closed and you are booking for tomorrow
3. Ask their full name if not mentioned
4. Ask what service they want if not mentioned
5. Ask what city or area they are from
6. Tell them their assigned time slot (do NOT let them pick — slots are first-come-first-served)
7. Confirm all details and ask for confirmation
8. When customer confirms, end your reply with this EXACT line:
   BOOKING_CONFIRMED: name=CUSTOMERNAME, phone=${from}, service=SERVICENAME, time=TIMESLOT, city=CITYNAME, date=DATESTR

Rules:
- DATESTR must be exactly: ${bookingDateStr}
- TIMESLOT must be exactly: ${assignedSlot || 'N/A'}
- Do NOT offer time choices — assign the slot automatically
- Keep replies short, friendly and clear
- Reply in the same language the customer uses (Hindi, Telugu or English)
- Never skip collecting name, service and city`
        },
        ...conversations[from]
      ]
    });

    const reply = response.choices[0].message.content;
    conversations[from].push({ role: 'assistant', content: reply });

    if (reply.includes('BOOKING_CONFIRMED:')) {
      const match = reply.match(/BOOKING_CONFIRMED: name=([^,]+), phone=([^,]+), service=([^,]+), time=([^,]+), city=([^,]+), date=(.+)/);
      if (match) {
        const bookingData = {
          name: match[1].trim(),
          phone: match[2].trim(),
          service: match[3].trim(),
          time: match[4].trim(),
          city: match[5].trim(),
          date: match[6].trim()
        };

        // Final check — make sure slot is still free
        const bookedNow = await getBookedSlotsFromSheet(bookingData.date);
        if (bookedNow.includes(bookingData.time.toLowerCase())) {
          res.set('Content-Type', 'text/xml');
          res.send(`<Response><Message>Sorry! That slot was just taken. Please send any message to get a new slot.</Message></Response>`);
          conversations[from] = conversations[from].slice(0, -2);
          return;
        }

        await axios.post(process.env.GOOGLE_SHEET_URL, bookingData)
          .catch(err => console.error('Sheets error:', err.message));

        scheduleReminder(bookingData);
        console.log(`Booking saved: ${bookingData.name} on ${bookingData.date} at ${bookingData.time}`);
      }
    }

    const cleanReply = reply.replace(/BOOKING_CONFIRMED:.*$/m, '').trim();
    console.log(`Bot reply: ${cleanReply}`);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error('Error:', error);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>Sorry, I am having trouble right now. Please call us directly.</Message></Response>`);
  }
});

// ─── Health Check ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Booking bot is running! ✅');
});

// ─── Start ─────────────────────────────────────────────────────────────────────

loadAndRescheduleReminders();

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot is running on port ${PORT}`);
});
