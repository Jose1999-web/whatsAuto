const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './auth' // Carpeta donde se guarda la sesión
    }),
    puppeteer: {
        headless: true, // Sin abrir ventana de navegador
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.clear();
    console.log("📌 Escanea este QR en WhatsApp:");
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.clear();
    console.log("✅ Sesión iniciada con éxito.");
});

client.initialize();
