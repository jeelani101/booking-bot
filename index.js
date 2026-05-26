// ─── WhatsApp Route ───────────────────────────────────────────────────────────

app.post('/whatsapp', async (req, res) => {
  const userMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${userMsg}`);

  // 1. IMMEDIATELY acknowledge Twilio so it never times out
  res.status(200).send('OK');

  // 2. Process everything else asynchronously
  try {
    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: userMsg });

    const afterCutoff = isAfterCutoff();
    const { slot: assignedSlot, dateStr: bookingDateStr } = await getNextAvailableSlot();

    // Build slot instructions — no ambiguity for the LLM
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
        slotInfo = `Next available slot: ${assignedSlot} on today (${bookingDateStr}). Assign this automatically — do NOT ask the customer to choose.`;
      }
    }

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
SLOT ASSIGNMENT — CRITICAL
==========================
${slotInfo}
${afterCutoff ? `
===========================
ABSOLUTE RULE — NO EXCEPTIONS
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
- Never let the customer pick a time — assign it
- Reply in the same language the customer uses (Hindi, Telugu, or English)
- Never skip collecting name, service, and city
- Keep replies short and friendly`
        },
        ...conversations[from]
      ]
    });

    const reply = response.choices[0].message.content;
    conversations[from].push({ role: 'assistant', content: reply });

    let cleanReply = reply;

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
            await twilioClient.messages.create({
              from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
              to: from,
              body: "Sorry! That slot was just taken. Send any message to get a new slot."
            });
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
      cleanReply = reply.replace(/BOOKING_CONFIRMED:.*$/m, '').trim();
    }

    console.log(`Bot reply: ${cleanReply}`);

    // 3. Send the message actively via Twilio REST Client API instead of TwiML response
    await twilioClient.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: cleanReply
    });

  } catch (error) {
    console.error('Error:', error);
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: "Sorry, I am having trouble right now. Please call us directly."
      });
    } catch (err) {
      console.error('Failed to send fallback error message:', err.message);
    }
  }
});
