const fs = require('fs');
const REMINDERS_FILE = './reminders.json';

// Load and reschedule all pending reminders on server start
function loadAndRescheduleReminders() {
  if (!fs.existsSync(REMINDERS_FILE)) return;
  
  const reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  const now = Date.now();
  const remaining = [];

  reminders.forEach(r => {
    const delay = r.reminderTime - now;
    if (delay > 0) {
      console.log(`Re-scheduling reminder for ${r.booking.name} in ${Math.round(delay/60000)} mins`);
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
    const slot = booking.time.toLowerCase();
    const isPM = slot.includes('pm');
    const isAM = slot.includes('am');
    const time = slot.replace('am', '').replace('pm', '').trim();
    let [hours, minutes] = time.includes(':') ? time.split(':').map(Number) : [parseInt(time), 0];
    if (isPM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    const appointmentTime = new Date();
    appointmentTime.setHours(hours, minutes || 0, 0, 0);

    const reminderTime = appointmentTime.getTime() - 30 * 60 * 1000;
    const delay = reminderTime - Date.now();

    if (delay <= 0) {
      console.log('Too soon for a 30-min reminder');
      return;
    }

    saveReminder(booking, reminderTime);
    scheduleReminderAt(booking, reminderTime);
    console.log(`Reminder scheduled for ${booking.name} in ${Math.round(delay/60000)} mins`);

  } catch (err) {
    console.error('Schedule error:', err.message);
  }
}

// Call this once when server starts
loadAndRescheduleReminders();
