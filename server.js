require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

app.post('/join-teams', async (req, res) => {
    const { meetingLink } = req.body;
    console.log("Request received:", req.body);

    if (!meetingLink) {
        return res.status(400).json({ error: 'Meeting link is required' });
    }

    let browser;
    try {
        console.log("🚀 Launching browser...");
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--use-fake-ui-for-media-stream', // Auto-approve mic/cam
                '--use-fake-device-for-media-stream', // Use a virtual media device
                '--disable-blink-features=AutomationControlled', // Avoid bot detection
                '--disable-features=IsolateOrigins,site-per-process', // Prevent isolation issues
            ]
        });

        const context = browser.defaultBrowserContext();
        await context.overridePermissions("https://teams.live.com", ["microphone", "camera"]);

        const page = await browser.newPage();
        console.log(`🌍 Opening Teams meeting: ${meetingLink}`);
        await page.goto(meetingLink, { waitUntil: 'networkidle2' });

        // Select "Continue on this browser"
        console.log("🔎 Looking for 'Continue on this browser' button...");
        const continueButton = await page.waitForSelector('button[data-tid="joinOnWeb"]', { timeout: 30000 });

        if (continueButton) {
            console.log("Clicking 'Continue on this browser'...");
            await continueButton.click();
        } else {
            throw new Error("❌ 'Continue on this browser' button not found!");
        }

        // Wait for login page
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Wait for the name input field to appear
        const nameInputSelector = 'input[data-tid="prejoin-display-name-input"]';
        await page.waitForSelector(nameInputSelector, { timeout: 1000 });


        // Type "Bot" into the name input field
        await page.type(nameInputSelector, 'Bot');
        console.log('Typed "Bot" in the name field');
        console.log("Logging in...");
        // await new Promise(resolve => setTimeout(resolve, 500000)); 
        // await page.type('input[name="loginfmt"]', process.env.TEAMS_EMAIL);
        // await page.click('input[type="submit"]');
        // await new Promise(resolve => setTimeout(resolve, 5000)); 

        // await page.type('input[name="passwd"]', process.env.TEAMS_PASSWORD);
        // await page.click('input[type="submit"]');
        // await new Promise(resolve => setTimeout(resolve, 5000));
        // Click the "Join now" button
        const joinNowButtonSelector = 'button[data-tid="prejoin-join-button"]';
        await page.waitForSelector(joinNowButtonSelector, { timeout: 10000 });
        await page.click(joinNowButtonSelector);
        console.log('Clicked "Join now" button');
        try {
            console.log("⏳ Waiting for host approval...");
            await page.waitForSelector(allowButtonSelector, { timeout: 30000 }); // Wait up to 30 seconds
            await page.click(allowButtonSelector);
            console.log("Allowed into the meeting automatically!");
        } catch (error) {
            console.log("No approval needed or timeout reached.");
        }
        console.log("🎤 Ensuring microphone and camera permissions...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log("Successfully joined the meeting!");

        res.json({ success: true, message: 'Bot joined the Teams meeting!' });
        await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: error.message });
    } finally {
        console.log("🚪 Closing browser...");
        if (browser) await browser.close();
    }
});

app.listen(5090, () => {
    console.log('🚀 Server running on port 5090');
    // console.log("📧 Email:", process.env.TEAMS_EMAIL);
    // console.log("🔑 Password:", process.env.TEAMS_PASSWORD ? "Loaded" : "Not Loaded");
});
