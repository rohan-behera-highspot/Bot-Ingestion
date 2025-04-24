const express = require('express');
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

app.post('/join-teams', async (req, res) => {
    const { meetingLink, isAudioOnly = true } = req.body;
    console.log("Request received:", req.body);

    if (!meetingLink) {
        return res.status(400).json({ error: 'Meeting link is required' });
    }

    let browser;
    let ffmpegProcess;
    const timestamp = Date.now();
    const outputFile = path.join(__dirname, isAudioOnly ? `audio_recording_${timestamp}.wav` : `meeting_recording_${timestamp}.mp4`);

    try {
        console.log("🚀 Launching browser...");
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--window-size=1920,1080',
                '--start-maximized',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ],
            defaultViewport: null
        });

        const context = browser.defaultBrowserContext();
        await context.overridePermissions("https://teams.live.com", ["microphone", "camera"]);

        const page = await browser.newPage();
        console.log(`🌍 Opening Teams meeting: ${meetingLink}`);
        await page.goto(meetingLink, { waitUntil: 'networkidle2' });

        const continueButton = await page.waitForSelector('button[data-tid="joinOnWeb"]', { timeout: 30000 });
        if (continueButton) await continueButton.click();

        const nameInputSelector = 'input[data-tid="prejoin-display-name-input"]';
        await page.waitForSelector(nameInputSelector);
        await page.type(nameInputSelector, 'Bot');

        const joinNowButtonSelector = 'button[data-tid="prejoin-join-button"]';
        await page.waitForSelector(joinNowButtonSelector);
        await page.click(joinNowButtonSelector);

        try {
            const allowButtonSelector = 'button[aria-label="Allow"]';
            await page.waitForSelector(allowButtonSelector, { timeout: 10000 });
            await page.click(allowButtonSelector);
        } catch { }

        // Wait until fully in the meeting
        await page.waitForFunction(() => document.querySelector('button[aria-label^="Leave"]') !== null, { timeout: 15000 });

        // Turn off mic/camera
        const micBtn = '#microphone-button';
        const camBtn = '#video-button';
        try {
            await page.waitForSelector(micBtn, { timeout: 10000 });
            await page.waitForSelector(camBtn, { timeout: 10000 });

            const micLabel = await page.$eval(micBtn, el => el.getAttribute('aria-label') || '');
            const camLabel = await page.$eval(camBtn, el => el.getAttribute('aria-label') || '');

            if (micLabel.toLowerCase().includes('mute')) await page.click(micBtn);
            if (!camLabel.toLowerCase().includes('turn camera on')) await page.click(camBtn);
        } catch (err) {
            console.warn("Mic/Camera toggle failed:", err.message);
        }

        // 📹 Start Recording
        console.log(`🎙️ Starting ${isAudioOnly ? 'audio' : 'audio+video'} recording...`);
        ffmpegProcess = spawn('/opt/homebrew/bin/ffmpeg', isAudioOnly
            ? [
                '-f', 'avfoundation',
                '-i', ':BlackHole 2ch',
                '-acodec', 'pcm_s16le',
                '-ac', '1',
                '-ar', '44100',
                outputFile
            ]
            : [
                '-f', 'avfoundation',
                '-i', '1:0',
                '-r', '60',
                '-video_size', '1280x720',
                '-vcodec', 'libx264',
                '-preset', 'ultrafast',
                '-pix_fmt', 'yuv420p',
                '-b:v', '3000k',
                '-acodec', 'aac',
                '-b:a', '192k',
                '-ar', '44100',
                '-ac', '2',
                '-filter:a', 'volume=2.0',
                '-strict', 'experimental',
                outputFile
            ]
        );

        ffmpegProcess.stderr.on('data', data => console.error(`FFmpeg: ${data}`));

        res.json({ success: true, message: 'Recording started', outputFile });

        // 🛑 Monitor Meeting End
        let meetingActive = true;
        (async () => {
            while (meetingActive) {
                const inMeeting = await page.evaluate(() => {
                    return !!document.querySelector('button[aria-label^="Leave"]');
                });

                if (!inMeeting) {
                    console.log("❌ Meeting ended. Stopping recording...");
                    ffmpegProcess.kill('SIGINT');
                    meetingActive = false;
                    await browser.close();
                    console.log("🚪 Browser closed.");
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        })();

    } catch (error) {
        console.error("❌ Error:", error);
        if (ffmpegProcess) ffmpegProcess.kill('SIGINT');
        if (browser) await browser.close();
        res.status(500).json({ error: error.message });
    }
});

app.listen(5090, () => {
    console.log('🚀 Server running on port 5090');
});
