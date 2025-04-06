const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'cab-management-419611-ef432b27086c.json'),
  scopes: SCOPES,
});

const calendar = google.calendar({ version: 'v3', auth });

async function getNextMeetingLink() {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 2 * 60 * 60000).toISOString(); // 2 hours

  try {
    const res = await calendar.events.list({
      calendarId: 'rohankumarbehera5@gmail.com',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items;
    console.log('event details:', events);
    console.log('Current time:', now);
    if (!events || events.length === 0) {
      console.log('❌ No upcoming events found in the next 15 minutes.');
      return null;
    }

    console.log(`📅 Found ${events.length} upcoming events.`);
    for (const event of events) {
      console.log(`🔍 Checking event: ${event.summary || '(No Title)'}`);
      const description = event.description || '';
      const location = event.location || '';
      const summary = event.summary || '';

      const combinedText = [description, location, summary].join(' ');

      const match = combinedText.match(/https:\/\/teams\.live\.com\/[^\s"]+/);
      if (match) {
        const meetingLink = match[0];
        console.log(`✅ Found Teams link: ${meetingLink}`);
        return meetingLink;
      }
    }

    console.log('❌ No Teams meeting link found in upcoming events.');
    return null;
  } catch (error) {
    console.error('⚠️ Error fetching calendar events:', error);
    return null;
  }
}

module.exports = {
  getNextMeetingLink,
};
