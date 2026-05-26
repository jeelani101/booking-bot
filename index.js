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

function getAvailableSlots() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const allSlots = [
    { label: '10:00am', minutes: 600 },
    { label: '10:30am', minutes: 630 },
    { label: '11:00am', minutes: 660 },
    { label: '11:30am', minutes: 690 },
    { label: '12:00pm', minutes: 720 },
    { label: '12:30pm', minutes: 750 },
    { label: '1:00pm',  minutes: 780 },
    { label: '1:30pm',  minutes: 810 },
    { label: '2:00pm',  minutes: 840 },
    { label: '2:30pm',  minutes: 870 },
    { label: '3:00pm',  minutes: 900 },
    { label: '3:30pm',  minutes: 930 },
    { label: '4:00pm',  minutes: 960 },
    { label: '4:30pm',  minutes: 990 },
    { label: '5:00pm',  minutes: 1000 },
  ];

  const available = allSlots.filter(s => s.minutes > currentMinutes + 30);

  if (available.length === 0) {
    return 'No slots available today. Please message us tomorrow morning!';
  }

  return available.map(s => s.label).join(', ');
}

function parseTime(timeStr) {
  try {
    const cleaned = timeStr.toLowerCase().trim();
    const match = cleaned.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (!match) return null;

    let hours = parseInt(match[1]);
    const minutes = match[2] ? parseInt(match[2]) : 0;
    const period = match[3];

    if (period === 'pm' && hours !== 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    if (!period && hours < 10) hours += 12;

    return { hours, minutes };
  } catch (e) {
    return null;
  }
}

function scheduleReminder(booking) {
  try {
    const parsed = parseTime(booking.time);
    if (!parsed) {
      console.log('Could not parse time:', booking.time);
      return;
    }

    const now = new Date();
    const appointmentTime = new Date();
    appointmentTime.setHours(parsed.hours, parsed.minutes, 0, 0);

    const reminderTime = new Date(appointmentTime.getTime() - 30 * 60 * 1000);
    const delay = reminderTime.getTime() - now.getTime();

    if (delay <= 0) {
      console.log('Too soon for reminder — skipping');
      return;
    }

    console.log(`Reminder set for ${booking.name} in ${Math.round(delay / 60000)} mins`);

    setTimeout(async () => {
      try {
        await twilioClient.messages.create({
          from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
          to: booking.phone,
          body: `Hi ${booking.name}! 👋 Reminder from ${process.env.BUSINESS_NAME || 'Smart Salon'}.

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

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMsg });

  const availableSlots = getAvailableSlots();
  const today = new Date().toLocaleDateString('en-IN');
  const currentTime = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true
  });

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a friendly appointment booking assistant for a salon.
Business name: ${process.env.BUSINESS_NAME || 'Smart Salon'}
Today's date: ${today}
Current time: ${currentTime}

AVAILABLE SLOTS TODAY: ${availableSlots}

STRICT RULES FOR SLOTS:
- ONLY show slots from the AVAILABLE SLOTS list above
- NEVER show or suggest any slot not in that list
- If available slots says "No slots available today" — tell customer to message tomorrow
- Slots include half-hour times like 10:30am, 2:30pm etc

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
5. Show available slots and ask which time they prefer
6. Confirm all details back to customer
7. When customer confirms, end your reply with EXACTLY this line:
   BOOKING_CONFIRMED: name=CUSTOMERNAME, phone=${from}, service=SERVICENAME, time=TIMESLOT, city=CITYNAME

Rules:
- Keep replies short, friendly and clear
- Reply in the same language the customer uses (Hindi, Telugu or English)
- Never skip collecting name, service, city and time`
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
          date: today
        };

        await axios.post(process.env.GOOGLE_SHEET_URL, bookingData)
          .catch(err => console.error('Sheets error:', err.message));

        scheduleReminder(bookingData);
        delete conversations[from];
        console.log(`Booking saved: ${bookingData.name} at ${bookingData.time}`);
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

app.get('/', (req, res) => {
  res.send('Booking bot is running! ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot is running on port ${PORT}`);
});
