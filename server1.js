require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH;

async function getCalendarEvents() {
    const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_CREDENTIALS_PATH,
        scopes: SCOPES,
    });
    const calendar = google.calendar({ version: 'v3', auth });
    
    const now = new Date();
    const events = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        maxResults: 10,
        singleEvents: true,
        orderBy: 'startTime',
    });
    
    return events.data.items.filter(event => event.hangoutLink || event.description);
}

async function getTeamsMeetingLink() {
    const events = await getCalendarEvents();
    for (let event of events) {
        const teamsLink = event.description?.match(/https:\/\/teams\.live\.com\/[^"]+/)?.[0];
        if (teamsLink) {
            return teamsLink;
        }
    }
    return null;
}

async function joinTeamsMeeting(meetingLink) {
    let browser;
    let ffmpegProcess;
    const outputFile = path.join(__dirname, `meeting_recording_${Date.now()}.mp4`);

    try {
        console.log("🚀 Launching headless browser...");
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const context = browser.defaultBrowserContext();
        await context.overridePermissions("https://teams.live.com", ["microphone", "camera"]);

        const page = await browser.newPage();
        console.log(`🌍 Opening Teams meeting: ${meetingLink}`);
        await page.goto(meetingLink, { waitUntil: 'networkidle2' });

        const continueButton = await page.waitForSelector('button[data-tid="joinOnWeb"]', { timeout: 30000 });
        if (continueButton) await continueButton.click();

        await page.waitForSelector('input[data-tid="prejoin-display-name-input"]', { timeout: 10000 });
        await page.type('input[data-tid="prejoin-display-name-input"]', 'Bot');
        
        await page.waitForSelector('button[data-tid="prejoin-join-button"]', { timeout: 10000 });
        await page.click('button[data-tid="prejoin-join-button"]');

        console.log("✅ Successfully joined the meeting!");

        // 🎥 Start Recording
        ffmpegProcess = spawn('ffmpeg', [
            '-f', 'avfoundation',
            '-i', '1:1',
            '-r', '30',
            '-video_size', '1920x1080',
            '-vcodec', 'libx264',
            '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p',
            '-b:v', '5000k',
            '-acodec', 'aac',
            '-b:a', '128k',
            '-strict', 'experimental',
            outputFile
        ]);

        ffmpegProcess.stdout.on('data', (data) => console.log(`FFmpeg: ${data}`));
        ffmpegProcess.stderr.on('data', (data) => console.error(`FFmpeg error: ${data}`));

        let meetingActive = true;
        (async () => {
            while (meetingActive) {
                const leaveButtonExists = await page.evaluate(() => {
                    return !!document.querySelector('button[aria-label^="Leave"]');
                });

                if (!leaveButtonExists) {
                    console.log("❌ Meeting has ended! Stopping recording...");
                    ffmpegProcess.kill('SIGINT');
                    meetingActive = false;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            console.log("🚪 Closing browser...");
            await browser.close();
        })();
    } catch (error) {
        console.error("❌ Error:", error);
    }
}

app.post('/join-teams', async (req, res) => {
    const meetingLink = await getTeamsMeetingLink();
    if (!meetingLink) {
        return res.status(404).json({ error: 'No upcoming Teams meeting found in Google Calendar' });
    }
    await joinTeamsMeeting(meetingLink);
    res.json({ success: true, message: 'Bot joined the Teams meeting!' });
});

app.listen(5090, () => {
    console.log('🚀 Server running on port 5090, checking Google Calendar every 5 minutes...');
    setInterval(async () => {
        const meetingLink = await getTeamsMeetingLink();
        if (meetingLink) await joinTeamsMeeting(meetingLink);
    }, 5 * 60 * 1000);
});
