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
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const allSlots = [
    { label: '10:00am', hour: 10, minute: 0 },
    { label: '11:00am', hour: 11, minute: 0 },
    { label: '12:00pm', hour: 12, minute: 0 },
    { label: '1:00pm',  hour: 13, minute: 0 },
    { label: '2:00pm',  hour: 14, minute: 0 },
    { label: '2:30pm',  hour: 14, minute: 30 },
    { label: '3:00pm',  hour: 15, minute: 0 },
    { label: '3:30pm',  hour: 15, minute: 30 },
    { label: '4:00pm',  hour: 16, minute: 0 },
    { label: '4:30pm',  hour: 16, minute: 30 },
    { label: '5:00pm',  hour: 17, minute: 0 },
  ];

  const available = allSlots.filter(slot => {
    if (slot.hour > currentHour) return true;
    if (slot.hour === currentHour && slot.minute > currentMinute) return true;
    return false;
  });

  return available.map(s => s.label).join(', ');
}

function parseAppointmentTime(timeStr) {
  try {
    const cleaned = timeStr.toLowerCase().trim();

    const match12 = cleaned.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
    if (match12) {
      let hours = parseInt(match12[1]);
      const minutes = match12[2] ? parseInt(match12[2]) : 0;
      const period = match12[3];

      if (period === 'pm' && hours !== 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;

      return { hours, minutes };
    }

    const match24 = cleaned.match(/(\d{1,2}):(\d{2})/);
    if (match24) {
      return {
        hours: parseInt(match24[1]),
        minutes: parseInt(match24[2])
      };
    }

    const matchHour = cleaned.match(/(\d{1,2})/);
    if (matchHour) {
      const h = parseInt(matchHour[1]);
      return { hours: h, minutes: 0 };
    }

    return null;
  } catch (e) {
    return null;
  }
}

function scheduleReminder(booking) {
  try {
    const parsed = parseAppointmentTime(booking.time);
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
      console.log(`Appointment too soon for reminder. Sending now instead.`);
      sendReminder(booking);
      return;
    }

    console.log(`Reminder scheduled for ${booking.name} in ${Math.round(delay / 60000)} minutes`);

    setTimeout(() => sendReminder(booking), delay);

  } catch (err) {
    console.error('Schedule error:', err.message);
  }
}

async function sendReminder(booking) {
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
    console.error('Reminder send error:', err.message);
  }
}

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMsg });

  const availableSlots = getAvailableSlots();

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a friendly appointment booking assistant for a salon.
Business name: ${process.env.BUSINESS_NAME || 'Smart Salon'}
Current time: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
Available slots RIGHT NOW (only show these, never show past slots): ${availableSlots || 'No slots available today. Please call tomorrow.'}

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
5. Show ONLY the available slots listed above and ask which time they prefer
6. Confirm all details back to customer
7. When customer confirms, end your reply with this EXACT line:
   BOOKING_CONFIRMED: name=CUSTOMERNAME, phone=${from}, service=SERVICENAME, time=TIMESLOT, city=CITYNAME

Important rules:
- NEVER show slots that are not in the available slots list
- Slots include both hour and half-hour times like 2:30pm, 3:30pm
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

app.get('/', (req, res) => {
  res.send('Booking bot is running! ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bot is running on port ${PORT}`);
});
