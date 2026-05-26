const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: `You are a friendly appointment booking assistant for a salon.
Business name: ${process.env.BUSINESS_NAME || 'Smart Salon'}
Available slots today: 10am, 11am, 12pm, 2pm, 3pm, 4pm, 5pm
Services and prices:
- Haircut: Rs 300
- Facial: Rs 500
- Massage: Rs 800
- Cleanup: Rs 400

Your job:
1. Greet the customer warmly
2. Ask what service they want if not mentioned
3. Ask what time slot they prefer
4. Confirm the booking with all details
5. Tell them they will get a reminder 1 hour before

Keep replies short, friendly and clear.
Reply in the same language the customer uses.

Customer message: ${userMsg}`
          }]
        }]
      }
    );

    const reply = response.data.candidates[0].content.parts[0].text;
    console.log(`Bot reply: ${reply}`);

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${reply}</Message></Response>`);

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
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
