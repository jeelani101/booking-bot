const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

Your job:
1. Greet the customer warmly
2. Ask their name if not mentioned
3. Ask what service they want if not mentioned
4. Ask what city or area they are in
5. Ask what time slot they prefer
6. Confirm the booking with all details
7. When booking is confirmed, include this exact line at the end:
   BOOKING_CONFIRMED: name=NAME, phone=PHONE, service=SERVICE, time=TIME, city=CITY

Keep replies short, friendly and clear.
Reply in the same language the customer uses.`
        },
        ...conversations[from]
      ]
    });

    const reply = response.choices[0].message.content;
    conversations[from].push({ role: 'assistant', content: reply });

    if (reply.includes('BOOKING_CONFIRMED:')) {
      const match = reply.match(/BOOKING_CONFIRMED: name=([^,]+), phone=([^,]+), service=([^,]+), time=(.+)/);
      if (match) {
        await axios.post(process.env.GOOGLE_SHEET_URL, {
          name: match[1].trim(),
          phone: match[2].trim(),
          service: match[3].trim(),
          time: match[4].trim(),
          date: new Date().toLocaleDateString('en-IN')
        }).catch(err => console.error('Sheets error:', err.message));
      }
    }

    const cleanReply = reply.replace(/BOOKING_CONFIRMED:.*/, '').trim();
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
