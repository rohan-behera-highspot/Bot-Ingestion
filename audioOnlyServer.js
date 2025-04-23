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

// Replace the mic/camera section with this improved version
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
            await page.waitForSelector(allowButtonSelector, { timeout: 10000 });
            await page.click(allowButtonSelector);
            console.log("Allowed into the meeting automatically!");
        } catch {
            console.log("No approval needed or timeout reached.");
        }

        console.log("✅ Successfully joined the meeting!");

        // IMPROVED SECTION: Turn off mic and camera after joining with more reliable detection
        console.log("🔄 Attempting to turn off mic and camera...");
        
        // Wait for meeting UI to fully load first (more reliable approach)
        await page.waitForFunction(() => {
            // Check if we're fully in the meeting by looking for key UI elements
            return document.querySelector('button[aria-label*="Leave"]') !== null;
        }, { timeout: 15000 }).catch(e => console.log("Meeting UI wait timed out, proceeding anyway:", e.message));
        
        // Define multiple possible selectors for robustness
        const micSelectors = [
            '#microphone-button' 
            // 'button[aria-label*="Mute"]',
            // 'button[data-tid="toggle-mute"]',
            // 'button[title*="Mute"]'
        ];
        
        const camSelectors = [
            '#video-button' 
            // 'button[aria-label*="camera"]',
            // 'button[data-tid="toggle-video"]',
            // 'button[title*="camera"]'
        ];

        // Function to try multiple selectors
        async function clickButtonWithMultipleSelectors(selectors, actionName) {
            for (const selector of selectors) {
                try {
                    const exists = await page.$(selector);
                    if (exists) {
                        // Check if we need to turn it off by examining the button state
                        const ariaLabel = await page.$eval(selector, el => el.getAttribute('aria-label') || el.title || '');
                        const needsToToggle = ariaLabel.toLowerCase().includes('mute') || 
                                            ariaLabel.toLowerCase().includes('turn off') || 
                                            ariaLabel.toLowerCase().includes('camera off');
                        
                        if (needsToToggle) {
                            await page.click(selector);
                            console.log(`✅ ${actionName} toggled using selector: ${selector}`);
                            return true;
                        } else {
                            console.log(`✅ ${actionName} already in desired state according to: ${selector}`);
                            return true;
                        }
                    }
                } catch (err) {
                    console.log(`Failed with selector ${selector}:`, err.message);
                }
            }
            return false;
        }

        // Try to turn off mic with multiple attempts
        let micSuccess = await clickButtonWithMultipleSelectors(micSelectors, "Microphone");
        if (!micSuccess) {
            console.warn("⚠️ Could not find or toggle microphone button");
        }
        
        // Try to turn off camera with multiple attempts
        let camSuccess = await clickButtonWithMultipleSelectors(camSelectors, "Camera");
        if (!camSuccess) {
            console.warn("⚠️ Could not find or toggle camera button");
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
