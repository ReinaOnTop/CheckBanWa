export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { number } = req.body;

    if (!number) {
        return res.status(400).json({ error: 'Phone number required' });
    }

    try {
        // Emulate WhatsApp registration check (Android-like)
        const response = await fetch(`https://v.whatsapp.net/v2/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'WhatsApp/2.23.8.76 Android/11 Device/Pixel',
            },
            body: `cc=${number.slice(0, 2)}&in=${number.slice(2)}&method=sms&mcc=000&mnc=000`
        });

        const text = await response.text();

        if (/banned/i.test(text)) {
            return res.json({ banned: true });
        } else {
            return res.json({ banned: false });
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error checking ban' });
    }
}
