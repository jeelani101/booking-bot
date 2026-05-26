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

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMsg });

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a friendly appointment booking assistant for a salon.
Business name: ${process.env.BUSINESS_NAME || 'Smart Salon'}
Available slots today: 10am, 11am, 12pm, 2pm, 3pm, 4pm, 5pm
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
5. Ask what time slot they prefer
6. Confirm all details back to customer
7. When customer confirms, end your reply with this EXACT line (fill in real values):
   BOOKING_CONFIRMED: name=CUSTOMERNAME, phone=${from}, service=SERVICENAME, time=TIMESLOT, city=CITYNAME

Important rules:
- Collect name, service, city and time BEFORE confirming
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

function scheduleReminder(booking) {
  try {
    const timeStr = booking.time.toLowerCase()
      .replace('am', '').replace('pm', '').trim();

    let [hours, minutes] = timeStr.includes(':')
      ? timeStr.split(':').map(Number)
      : [parseInt(timeStr), 0];

    if (booking.time.toLowerCase().includes('pm') && hours !== 12) hours += 12;
    if (booking.time.toLowerCase().includes('am') && hours === 12) hours = 0;

    const now = new Date();
    const appointmentTime = new Date();
    appointmentTime.setHours(hours, minutes || 0, 0, 0);

    const reminderTime = new Date(appointmentTime.getTime() - 30 * 60 * 1000);
    const delay = reminderTime.getTime() - now.getTime();

    if (delay <= 0) {
      console.log('Appointment is too soon for a 30-min reminder');
      return;
    }

    console.log(`Reminder scheduled for ${booking.name} in ${Math.round(delay/60000)} minutes`);

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
