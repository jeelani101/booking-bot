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
const pendingBookings = new Set();
const REMINDERS_FILE = './reminders.json';
const BOOKING_CUTOFF_HOUR = 18; // 6:00 PM

const ALL_SLOTS = ['10:00am', '11:00am', '12:00pm', '2:00pm', '3:00pm', '4:00pm', '5:00pm'];

// ─── XML Escape (FIXES WhatsApp not receiving messages) ───────────────────────
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Slot Utilities ───────────────────────────────────────────────────────────

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
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow;
  }
  return now;
}

function getDateStr(dateObj) {
  const day = dateObj.getDate().toString().padStart(2, '0');
  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const year = dateObj.getFullYear();
  return `${day}/${month}/${year}`;
}

function getAvailableSlotsForToday() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes() + 30;
  return ALL_SLOTS.filter(slot => slotToMinutes(slot) > currentMinutes);
}

async function getBookedSlotsFromSheet(dateStr) {
  try {
    const response = await axios.get(
      process.env.GOOGLE_SHEET_URL + '?date=' + encodeURIComponent(dateStr)
    );
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

async function getNextAvailableSlot() {
  const bookingDate = getBookingDate();
  const dateStr = getDateStr(bookingDate);
  const bookedSlots = await getBookedSlotsFromSheet(dateStr);
  // After cutoff: use ALL_SLOTS for tomorrow (no time filtering)
  // Before cutoff: filter out slots too close to now
  const candidateSlots = isAfterCutoff() ? ALL_SLOTS : getAvailableSlotsForToday();
  const nextSlot = candidateSlots.find(slot => !bookedSlots.includes(slot.toLowerCase()));
  return { slot: nextSlot || null, dateStr };
}

// ─── Reminder Utilities ───────────────────────────────────────────────────────

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
        body: `Hi ${booking.name}! Reminder from ${process.env.BUSINESS_NAME || 'Smart Salon'}.

Your appointment is in 30 minutes!
Service: ${booking.service}
Time: ${booking.time}
Date: ${booking.date}
City: ${booking.city}

See you soon!`
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

// ─── WhatsApp Route ───────────────────────────────────────────────────────────

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMsg });

  const afterCutoff = isAfterCutoff();
  const { slot: assignedSlot, dateStr: bookingDateStr } = await getNextAvailableSlot();

  // Build ironclad slot instructions — no ambiguity for the LLM
  let slotInfo = '';
  if (afterCutoff) {
    if (!assignedSlot) {
      slotInfo = `TODAY IS CLOSED. TOMORROW (${bookingDateStr}) is also fully booked. Tell the customer politely there are no slots available and ask them to call directly. DO NOT offer or mention any slot for today under any circumstances.`;
    } else {
      slotInfo = `TODAY IS FULLY CLOSED FOR BOOKINGS. You are booking for TOMORROW (${bookingDateStr}) ONLY.
Assigned slot: ${assignedSlot} on ${bookingDateStr}.
NEVER mention today. NEVER offer today. NEVER say "we have an opening today".
Tell the customer: today's bookings are closed, and their appointment will be TOMORROW at ${assignedSlot}.`;
    }
  } else {
    if (!assignedSlot) {
      slotInfo = `No slots available for today (${bookingDateStr}). Tell the customer politely and ask them to call directly.`;
    } else {
      slotInfo = `Next available slot: ${assignedSlot} on today (${bookingDateStr}). Assign this automatically - do NOT ask the customer to choose.`;
    }
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
Working hours: 10:00am to 5:00pm. Bookings close at 6:00pm sharp every day.

==========================
SLOT ASSIGNMENT - CRITICAL
==========================
${slotInfo}
${afterCutoff ? `
===========================
ABSOLUTE RULE - NO EXCEPTIONS
===========================
It is past 6:00 PM. Today is PERMANENTLY CLOSED for bookings.
- You MUST NOT offer, mention, suggest, or imply any slot for TODAY.
- You MUST ONLY book for TOMORROW (${bookingDateStr}).
- If the customer asks about today, say: "Sorry, today's bookings are closed. I can book you for tomorrow."
- There is NO situation where you book for today. NONE.
` : ''}

Services and prices:
- Haircut: Rs 300
- Facial: Rs 500
- Massage: Rs 800
- Cleanup: Rs 400

Steps to follow in order:
1. Greet the customer warmly
2. ${afterCutoff ? `Immediately tell them: today is closed, you are booking for TOMORROW (${bookingDateStr})` : 'Greet and proceed to collect details'}
3. Ask for their full name (if not given)
4. Ask what service they want (if not given)
5. Ask what city or area they are from (if not given)
6. Confirm their assigned slot: ${assignedSlot || 'N/A'} on ${bookingDateStr}
7. Ask for confirmation
8. On confirmation, end your reply with EXACTLY:
   BOOKING_CONFIRMED: name=CUSTOMERNAME, phone=${from}, service=SERVICENAME, time=TIMESLOT, city=CITYNAME, date=DATESTR

Hard rules:
- DATESTR must be exactly: ${bookingDateStr}
- TIMESLOT must be exactly: ${assignedSlot || 'N/A'}
- Never let the customer pick a time - assign it
- Reply in the same language the customer uses (Hindi, Telugu, or English)
- Never skip collecting name, service, and city
- Keep replies short and friendly
- Do NOT use special characters like &, <, > in your replies`
        },
        ...conversations[from]
      ]
    });

    const reply = response.choices[0].message.content;
    conversations[from].push({ role: 'assistant', content: reply });

    if (reply.includes('BOOKING_CONFIRMED:')) {
      const match = reply.match(
        /BOOKING_CONFIRMED: name=([^,]+), phone=([^,]+), service=([^,]+), time=([^,]+), city=([^,]+), date=(.+)/
      );
      if (match) {
        const bookingKey = `${from}_${match[4].trim()}_${match[6].trim()}`;

        if (!pendingBookings.has(bookingKey)) {
          pendingBookings.add(bookingKey);

          const bookingData = {
            name: match[1].trim(),
            phone: match[2].trim(),
            service: match[3].trim(),
            time: match[4].trim(),
            city: match[5].trim(),
            date: match[6].trim()
          };

          // Final safety check — slot must still be free
          const bookedNow = await getBookedSlotsFromSheet(bookingData.date);
          if (bookedNow.includes(bookingData.time.toLowerCase())) {
            res.set('Content-Type', 'text/xml');
            res.send(`<Response><Message>Sorry! That slot was just taken. Send any message to get a new slot.</Message></Response>`);
            conversations[from] = conversations[from].slice(0, -2);
            pendingBookings.delete(bookingKey);
            return;
          }

          await axios.post(process.env.GOOGLE_SHEET_URL, bookingData)
            .catch(err => console.error('Sheets error:', err.message));

          scheduleReminder(bookingData);
          console.log(`Booking saved: ${bookingData.name} on ${bookingData.date} at ${bookingData.time}`);
          delete conversations[from];
        }
      }
    }

    const cleanReply = reply.replace(/BOOKING_CONFIRMED:.*$/m, '').trim();
    console.log(`Bot reply: ${cleanReply}`);

    res.set('Content-Type', 'text/xml');
    // escapeXml() fixes special characters (&, <, >, etc.) that break TwiML XML
    // and cause WhatsApp to silently drop the message
    res.send(`<Response><Message>${escapeXml(cleanReply)}</Message></Response>`);

  } catch (error) {
    console.error('Error:', error);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>Sorry, I am having trouble right now. Please call us directly.</Message></Response>`);
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('Booking bot is running!');
});

// ─── Start ────────────────────────────────────────────────────────────────────

loadAndRescheduleReminders();

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot is running on port ${PORT}`);
});
