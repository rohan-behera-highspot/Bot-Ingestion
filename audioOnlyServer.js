const path = require('path');
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

app.post('/join-teams', async (req, res) => {
    const { meetingLink } = req.body;
    console.log("Request received:", req.body);

    if (!meetingLink) {
        return res.status(400).json({ error: 'Meeting link is required' });
    }

    const outputPath = path.join(__dirname, `audio_recording_${Date.now()}.wav`);
    const inputDevice = 'avfoundation';
    const inputSource = ':BlackHole 2ch'; // Or ':0' for default mic

    let browser;
    let responseSent = false;
    let ffmpegProcess;

    try {
        console.log("🚀 Launching browser...");
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--window-size=1920,1080', // Full HD window size
                '--start-maximized',       // Attempt to maximize the window
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ],
            defaultViewport: null // This is important to use full window size
        });
        

        const context = browser.defaultBrowserContext();
        await context.overridePermissions("https://teams.live.com", ["microphone", "camera"]);

        const page = await browser.newPage();
        console.log(`🌍 Opening Teams meeting: ${meetingLink}`);
        await page.goto(meetingLink, { waitUntil: 'networkidle2' });

        const continueButton = await page.waitForSelector('button[data-tid="joinOnWeb"]', { timeout: 30000 });
        if (continueButton) {
            console.log("Clicking 'Continue on this browser'...");
            await continueButton.click();
        } else {
            throw new Error("❌ 'Continue on this browser' button not found!");
        }

        const nameInputSelector = 'input[data-tid="prejoin-display-name-input"]';
        await page.waitForSelector(nameInputSelector, { timeout: 15000 });
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
        } catch {
            console.log("No approval needed or timeout reached.");
        }

        console.log("✅ Successfully joined the meeting!");

        // 🔇 Turn off mic and camera after joining
        try {
            const micBtn = '#microphone-button';
            const camBtn = '#video-button';

            await page.waitForSelector(micBtn, { timeout: 10000 });
            await page.waitForSelector(camBtn, { timeout: 10000 });

            const micLabel = await page.$eval(micBtn, el => el.getAttribute('aria-label'));
            const camLabel = await page.$eval(camBtn, el => el.getAttribute('aria-label'));

            if (micLabel && micLabel.toLowerCase().includes('mute')) {
                await page.click(micBtn);
                console.log("🎤 Microphone turned off");
            } else {
                console.log("🎤 Microphone already off");
            }

            if (camLabel && camLabel.toLowerCase().includes('turn camera on')) {
                console.log("📷 Camera already off");
            } else {
                await page.click(camBtn);
                console.log("📷 Camera turned off");
            }

        } catch (err) {
            console.warn("⚠️ Failed to toggle mic/camera:", err.message);
        }

        console.log("🎤 Starting audio recording using FFmpeg...");
        ffmpegProcess = spawn('/opt/homebrew/bin/ffmpeg', [
            '-f', inputDevice,
            '-i', inputSource,
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '44100',
            outputPath
        ]);

        ffmpegProcess.stderr.on('data', (data) => {
            console.error(`FFmpeg stderr: ${data}`);
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                console.log('✅ Audio recording complete.');
                if (!responseSent) {
                    responseSent = true;
                    res.json({ success: true, message: 'Audio recording complete', file: outputPath });
                }
            } else {
                console.error(`FFmpeg exited with code ${code}`);
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).json({ error: `FFmpeg exited with code ${code}` });
                }
            }
        });

        // Monitor for meeting end
        (async () => {
            let meetingActive = true;
            while (meetingActive) {
                const stillInMeeting = await page.evaluate(() => {
                    return !!document.querySelector('button[aria-label^="Leave"]');
                });

                if (!stillInMeeting) {
                    console.log("❌ Meeting has ended! Stopping recording...");
                    meetingActive = false;
                    ffmpegProcess.kill('SIGINT'); // Gracefully stop FFmpeg
                }

                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            await browser.close();
            console.log("🚪 Browser closed.");
        })();

    } catch (error) {
        console.error("❌ Error:", error);
        if (!responseSent) {
            responseSent = true;
            res.status(500).json({ error: error.message });
        }
        if (ffmpegProcess) ffmpegProcess.kill('SIGINT');
        if (browser) await browser.close();
    }
});

app.listen(5090, () => {
    console.log('🚀 Server running on port 5090');
});
