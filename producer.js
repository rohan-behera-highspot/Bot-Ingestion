const path = require('path');
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const { spawn } = require('child_process');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');

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

    const inputDevice = 'avfoundation';
    const inputSource = ':BlackHole 2ch';
    const RABBIT_URL = 'amqp://localhost';
    const QUEUE_NAME = 'audio_chunks';

    let browser;
    let responseSent = false;
    let ffmpegProcess;
    let sessionId = uuidv4();
    let chunkId = 0;

    try {
        const connection = await amqp.connect(RABBIT_URL);
        const channel = await connection.createChannel();
        await channel.assertQueue(QUEUE_NAME, { durable: false });

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

        const micSelectors = ['#microphone-button'];
        const camSelectors = ['#video-button'];

        async function clickButtonWithMultipleSelectors(selectors, actionName) {
            for (const selector of selectors) {
                try {
                    const exists = await page.$(selector);
                    if (exists) {
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

        await clickButtonWithMultipleSelectors(micSelectors, "Microphone");
        await clickButtonWithMultipleSelectors(camSelectors, "Camera");

        console.log("🎤 Starting audio streaming using FFmpeg and RabbitMQ...");

        ffmpegProcess = spawn('/opt/homebrew/bin/ffmpeg', [
            '-f', inputDevice,
            '-i', inputSource,
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '44100',
            '-f', 'wav',
            'pipe:1'
        ]);

        // 🧠 NEW BUFFERING LOGIC FOR 15s AUDIO CHUNKS
        let audioBuffer = [];
        let bufferStartTime = Date.now();
        const CHUNK_DURATION_MS = 15000;

        ffmpegProcess.stdout.on('data', (chunk) => {
            audioBuffer.push(chunk);

            const elapsed = Date.now() - bufferStartTime;
            if (elapsed >= CHUNK_DURATION_MS) {
                const fullChunk = Buffer.concat(audioBuffer);
                const message = {
                    session_id: sessionId,
                    chunk_id: chunkId++,
                    is_last_chunk: false,
                    audio_chunk: fullChunk.toString('base64')
                };

                try {
                    const bufferMessage = Buffer.from(JSON.stringify(message));
                    channel.sendToQueue(QUEUE_NAME, bufferMessage);
                    console.log(`📤 Sent 15s chunk ${chunkId} (${fullChunk.length} bytes)`);
                } catch (err) {
                    console.error("Failed to send buffered chunk:", err);
                }

                audioBuffer = [];
                bufferStartTime = Date.now();
            }
        });

        ffmpegProcess.stderr.on('data', (data) => {
            console.error(`FFmpeg stderr: ${data}`);
        });

        ffmpegProcess.on('close', async (code) => {
            const finalChunk = Buffer.concat(audioBuffer); // flush remaining audio
            const finalMessage = {
                session_id: sessionId,
                chunk_id: chunkId++,
                is_last_chunk: true,
                audio_chunk: finalChunk.toString('base64')
            };

            channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(finalMessage)));

            await channel.close();
            await connection.close();
            console.log("📡 RabbitMQ connection closed.");

            if (!responseSent) {
                responseSent = true;
                res.json({ success: true, message: 'Streaming ended and connection closed' });
            }
        });

        (async () => {
            let meetingActive = true;
            while (meetingActive) {
                const stillInMeeting = await page.evaluate(() => {
                    return !!document.querySelector('button[aria-label^="Leave"]');
                });

                if (!stillInMeeting) {
                    console.log("❌ Meeting has ended! Stopping recording...");
                    meetingActive = false;
                    ffmpegProcess.kill('SIGINT');
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
