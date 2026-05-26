const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};

// All possible slots
const ALL_SLOTS = ['10:00am', '11:00am', '12:00pm', '2:00pm', '3:00pm', '4:00pm', '5:00pm'];

// Convert slot string to 24h minutes for comparison
function slotToMinutes(slot) {
  const isPM = slot.includes('pm');
  const isAM = slot.includes('am');
  const time = slot.replace('am', '').replace('pm', '').trim();
  let [hours, minutes] = time.includes(':') ? time.split(':').map(Number) : [parseInt(time), 0];
  if (isPM && hours !== 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  return hours * 60 + (minutes || 0);
}

// Get slots that are still in the future (with 30min buffer)
function getFutureSlots() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes() + 30; // 30min buffer
  return ALL_SLOTS.filter(slot => slotToMinutes(slot) > currentMinutes);
}

// Fetch already booked slots from Google Sheet for today
async function getBookedSlots() {
  try {
    const today = new Date().toLocaleDateString('en-IN');
    const response = await axios.get(process.env.GOOGLE_SHEET_URL + '?date=' + encodeURIComponent(today));
    const bookings = response.data; // expects array of { time, date } objects
    return bookings
      .filter(b => b.date === today)
      .map(b => b.time.toLowerCase().trim());
  } catch (err) {
    console.error('Could not fetch booked slots:', err.message);
    return []; // If fetch fails, assume no bookings (fail open)
  }
}

// Get available slots = future slots minus booked ones
async function getAvailableSlots() {
  const future = getFutureSlots();
  const booked = await getBookedSlots();
  return future.filter(slot => !booked.includes(slot.toLowerCase()));
}

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMsg });

  // Get real-time available slots
  const availableSlots = await getAvailableSlots();
  const slotsText = availableSlots.length > 0
    ? availableSlots.join(', ')
    : 'No slots available for today';

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a friendly appointment booking assistant for a salon.
Business name: ${process.env.BUSINESS_NAME || 'Smart Salon'}

Available slots for TODAY (already filtered - past and booked slots removed):
${slotsText}

IMPORTANT: Only offer slots from the list above. Do NOT suggest any other times.
If no slots are available, politely inform the customer and ask them to call directly.

Services and prices:
- Haircut: Rs 300
- Facial: Rs 500
- Massage: Rs 800
- Cleanup: Rs 400

Your job - follow these steps in order:
1. Greet the customer warmly
2. Ask their full name if not mentioned
3. Ask what service they want if not mentioned
4. Ask what city or area they are from
5. Show available slots and ask which they prefer
6. Confirm all details back to customer
7. When customer confirms, end your reply with this EXACT line (fill in real values):
   BOOKING_CONFIRMED: name=CUSTOMERNAME, phone=${from}, service=SERVICENAME, time=TIMESLOT, city=CITYNAME

Important rules:
- Collect name, service, city and time BEFORE confirming
- Only accept a time slot from the available list above
- Keep replies short, friendly and clear
- Reply in the same language the customer uses (Hindi, Telugu or English)
- Never skip collecting name and city`
        },
        ...conversations[from]
      ]
    });

    const reply = response.choices[0].message.content;
    conversations[from].push({ role: 'assistant', content: reply });

    if (reply.includes('BOOKING_CONFIRMED:')) {
      const match = reply.match(/BOOKING_CONFIRMED: name=([^,]+), phone=([^,]+), service=([^,]+), time=([^,]+), city=(.+)/);
      if (match) {
        const bookingData = {
          name: match[1].trim(),
          phone: match[2].trim(),
          service: match[3].trim(),
          time: match[4].trim(),
          city: match[5].trim(),
          date: new Date().toLocaleDateString('en-IN')
        };

        // Double-check slot is still available before saving
        const stillAvailable = await getAvailableSlots();
        const requestedSlot = bookingData.time.toLowerCase().trim();
        const isValid = stillAvailable.some(s => s.toLowerCase() === requestedSlot);

        if (!isValid) {
          // Slot was taken between conversation start and confirmation
          res.set('Content-Type', 'text/xml');
          res.send(`<Response><Message>Sorry! That slot just got booked by someone else. Please type anything to see updated available slots and choose again.</Message></Response>`);
          // Reset last few messages so user can re-pick
          conversations[from] = conversations[from].slice(0, -2);
          return;
        }

        await axios.post(process.env.GOOGLE_SHEET_URL, bookingData)
          .catch(err => console.error('Sheets error:', err.message));

        scheduleReminder(bookingData);
        console.log('Booking saved and reminder scheduled!');
      }
    }

    const cleanReply = reply.replace(/BOOKING_CONFIRMED:.*$/m, '').trim();
    console.log(`Bot reply: ${cleanReply}`);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error('Error:', error);
    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>Sorry, I am having trouble right now. Please call us directly to book.</Message></Response>`);
  }
});

function scheduleReminder(booking) {
  try {
    const slot = booking.time.toLowerCase();
    const isPM = slot.includes('pm');
    const isAM = slot.includes('am');
    const time = slot.replace('am', '').replace('pm', '').trim();
    let [hours, minutes] = time.includes(':') ? time.split(':').map(Number) : [parseInt(time), 0];
    if (isPM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    const now = new Date();
    const appointmentTime = new Date();
    appointmentTime.setHours(hours, minutes || 0, 0, 0);

    const reminderTime = new Date(appointmentTime.getTime() - 30 * 60 * 1000);
    const delay = reminderTime.getTime() - now.getTime();

    if (delay <= 0) {
      console.log('Appointment is too soon for a 30-min reminder');
      return;
    }

    console.log(`Reminder scheduled for ${booking.name} in ${Math.round(delay / 60000)} minutes`);

    setTimeout(async () => {
      try {
        await twilioClient.messages.create({
          from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
          to: booking.phone,
          body: `Hi ${booking.name}! 👋 This is a reminder from ${process.env.BUSINESS_NAME || 'Smart Salon'}.

Your appointment is in 30 minutes!
📋 Service: ${booking.service}
⏰ Time: ${booking.time}
📍 City: ${booking.city}

See you soon! 😊`
        });
        console.log(`Reminder sent to ${booking.name}!`);
      } catch (err) {
        console.error('Reminder error:', err.message);
      }
    }, delay);

  } catch (err) {
    console.error('Schedule error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.send('Booking bot is running! ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot is running on port ${PORT}`);
});
