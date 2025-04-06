require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const { getNextMeetingLink } = require('./test'); // Your calendar logic file

const app = express();
app.use(express.json());

app.post('/join-scheduled-meeting', async (req, res) => {
    const meetingLink = await getNextMeetingLink();

    if (!meetingLink) {
        return res.status(404).json({ error: 'No Teams meeting link found in upcoming events.' });
    }

    console.log("🎯 Joining scheduled meeting:", meetingLink);

    let browser;
    let ffmpegProcess;
    const outputFile = path.join(__dirname, `meeting_recording_${Date.now()}.mp4`);

    try {
        console.log("🚀 Launching browser...");
        browser = await puppeteer.launch({
            headless: false,
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

        console.log("🔎 Looking for 'Continue on this browser' button...");
        const continueButton = await page.waitForSelector('button[data-tid="joinOnWeb"]', { timeout: 30000 });

        if (continueButton) {
            console.log("Clicking 'Continue on this browser'...");
            await continueButton.click();
        } else {
            throw new Error("❌ 'Continue on this browser' button not found!");
        }

        const nameInputSelector = 'input[data-tid="prejoin-display-name-input"]';
        await page.waitForSelector(nameInputSelector, { timeout: 10000 });
        await page.type(nameInputSelector, 'Bot');
        console.log('Typed "Bot" in the name field');

        const joinNowButtonSelector = 'button[data-tid="prejoin-join-button"]';
        await page.waitForSelector(joinNowButtonSelector, { timeout: 10000 });
        await page.click(joinNowButtonSelector);
        console.log('Clicked "Join now" button');

        console.log("⏳ Waiting for host approval...");
        try {
            const allowButtonSelector = 'button[aria-label="Allow"]';
            await page.waitForSelector(allowButtonSelector, { timeout: 30000 });
            await page.click(allowButtonSelector);
            console.log("Allowed into the meeting automatically!");
        } catch (error) {
            console.log("No approval needed or timeout reached.");
        }

        console.log("✅ Successfully joined the meeting!");
        res.json({ success: true, message: 'Bot joined the Teams meeting!' });

        // **🎥 Start recording as soon as the bot joins the meeting**
        console.log("🎥 Starting screen and audio recording using FFmpeg...");
        ffmpegProcess = spawn('ffmpeg', [
            '-f', 'avfoundation',   // Use avfoundation for macOS
            '-i', '1:1',            // Screen index 1, Audio index 1 (BlackHole 2ch)
            '-r', '30',             // 30 FPS
            '-video_size', '1920x1080',  // Set resolution
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
        console.log(`📂 Recording started. Saving to: ${outputFile}`);

        // **🛑 Monitor for the "Meeting ended" screen in parallel**
        let meetingActive = true;
        (async () => {
            while (meetingActive) {
                const leaveButtonExists = await page.evaluate(() => {
                    return !!document.querySelector('button[aria-label^="Leave"]');
                });

                if (!leaveButtonExists) {
                    console.log("❌ Meeting has ended! Stopping recording...");
                    ffmpegProcess.kill('SIGINT'); // Stop FFmpeg
                    meetingActive = false;
                } else {
                    console.log("✅ Meeting still ongoing...");
                }
                await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 sec
            }

            console.log("🚪 Closing browser...");
            await browser.close();
        })();

    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(5090, () => {
    console.log('🚀 Server running on port 5090');
});
