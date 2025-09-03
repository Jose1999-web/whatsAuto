const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");

// --- Configuración ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const YOUR_TELEGRAM_USER_ID = process.env.YOUR_TELEGRAM_USER_ID || "6534104615";
const WHATSAPP_TELEGRAM_GROUP_ID = process.env.WHATSAPP_TELEGRAM_GROUP_ID || "-1002519574888";
const CHAT_MAP_FILE = "./chat_topic_map.json";
const NOTIFY_PERSONAL_CHAT = true;
const PORT = process.env.PORT || 10000;
const URL = process.env.RENDER_EXTERNAL_URL; // Render asigna esta URL

// --- Inicializar Express para Webhook ---
const app = express();
app.use(bodyParser.json());

// --- Cliente WhatsApp ---
const whatsappClient = new Client({
  authStrategy: new LocalAuth({ dataPath: "./auth" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
});

// --- Cliente Telegram en modo Webhook ---
const telegramBot = new TelegramBot(TELEGRAM_TOKEN);
telegramBot.setWebHook(`${URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  telegramBot.processUpdate(req.body);
  res.sendStatus(200);
});

// --- Manejo de mapeo de chats ---
let chatTopicMapping = {};
let pendingReplies = {};
try {
  chatTopicMapping = JSON.parse(fs.readFileSync(CHAT_MAP_FILE));
} catch (e) {
  console.log("No se encontró el archivo de mapeo de temas. Se creará uno nuevo.");
}

const saveChatTopicMapping = () => {
  fs.writeFileSync(CHAT_MAP_FILE, JSON.stringify(chatTopicMapping, null, 2));
};

const sendMessageToTelegram = (chatId, message, options = {}) => {
  telegramBot
    .sendMessage(chatId, message, {
      parse_mode: "Markdown",
      ...options,
    })
    .catch((err) => console.error("Error al enviar a Telegram:", err));
};

// --- Eventos WhatsApp ---
whatsappClient.on("qr", (qr) => {
  console.log("📌 Escanea este QR con tu WhatsApp:");
  require("qrcode-terminal").generate(qr, { small: true });
});

whatsappClient.on("ready", () => {
  console.log("✅ WhatsApp conectado.");
  sendMessageToTelegram(
    WHATSAPP_TELEGRAM_GROUP_ID,
    "✅ Bot conectado a WhatsApp.",
    { message_thread_id: 1 }
  );
});

whatsappClient.on("message", async (msg) => {
  if (msg.fromMe) return;

  try {
    const contact = await msg.getContact();
    const contactName = contact.pushname || contact.number;
    const waId = msg.from;
    let topicId = chatTopicMapping[waId];

    const createMessageHeader = (name, id, body) => {
      const waId_text = `\`${id}\``;
      const messageBody_text = body || "_(Sin texto)_";
      return `*${name}* (${waId_text}):\n${messageBody_text}`;
    };

    if (!topicId) {
      console.log(`Creando tema para el nuevo contacto: ${contactName}`);
      const topic = await telegramBot
        .createForumTopic(WHATSAPP_TELEGRAM_GROUP_ID, contactName)
        .catch((err) => {
          console.error("Error al crear el tema en Telegram:", err);
          return null;
        });
      if (topic) {
        topicId = topic.message_thread_id;
        chatTopicMapping[waId] = topicId;
        saveChatTopicMapping();
        sendMessageToTelegram(
          WHATSAPP_TELEGRAM_GROUP_ID,
          `🆕 Mensajes de *${contactName}* se gestionarán en este tema.`,
          { message_thread_id: topicId }
        );
      } else {
        topicId = undefined;
      }
    }

    const media = msg.hasMedia ? await msg.downloadMedia() : null;
    const messageHeader = createMessageHeader(contactName, waId, msg.body);
    const options = {
      parse_mode: "Markdown",
      message_thread_id: topicId || 1,
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Responder", callback_data: `REPLY_${waId}` }]],
      },
    };

    if (media) {
      const mediaBuffer = Buffer.from(media.data, "base64");

      if (media.mimetype.startsWith("image")) {
        await telegramBot.sendPhoto(WHATSAPP_TELEGRAM_GROUP_ID, mediaBuffer, {
          ...options,
          caption: messageHeader,
        });
      } else if (media.mimetype.startsWith("video")) {
        await telegramBot.sendVideo(WHATSAPP_TELEGRAM_GROUP_ID, mediaBuffer, {
          ...options,
          caption: messageHeader,
        });
      } else if (media.mimetype.startsWith("audio") || media.mimetype.startsWith("voice")) {
        await telegramBot.sendAudio(WHATSAPP_TELEGRAM_GROUP_ID, mediaBuffer, {
          ...options,
          caption: messageHeader,
        });
      } else {
        await telegramBot.sendDocument(WHATSAPP_TELEGRAM_GROUP_ID, mediaBuffer, {
          ...options,
          caption: messageHeader,
        });
      }
    } else {
      sendMessageToTelegram(WHATSAPP_TELEGRAM_GROUP_ID, messageHeader, options);
    }

    if (NOTIFY_PERSONAL_CHAT) {
      sendMessageToTelegram(
        YOUR_TELEGRAM_USER_ID,
        `🔔 Nuevo mensaje de *${contactName}*: ${msg.body || "[Archivo adjunto]"}`
      );
    }
  } catch (err) {
    console.error("Error al procesar mensaje de WhatsApp:", err);
  }
});

// --- Manejo de respuestas desde Telegram ---
telegramBot.on("callback_query", (callbackQuery) => {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const fromId = callbackQuery.from.id;
  const topicId = callbackQuery.message.message_thread_id;

  if (data.startsWith("REPLY_")) {
    const waId = data.substring(6);
    pendingReplies[fromId] = waId;
    telegramBot.answerCallbackQuery(callbackQuery.id, { text: "Listo para responder." });
    sendMessageToTelegram(chatId, "📝 Por favor, envía tu respuesta ahora.", {
      message_thread_id: topicId,
      reply_to_message_id: messageId,
    });
  }
});

telegramBot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const topicId = msg.message_thread_id;

  if (chatId !== Number(WHATSAPP_TELEGRAM_GROUP_ID) || !pendingReplies[fromId]) {
    return;
  }

  const waId = pendingReplies[fromId];

  try {
    let sent = false;
    if (msg.text) {
      await whatsappClient.sendMessage(waId, msg.text);
      sent = true;
    } else if (msg.photo) {
      const fileLink = await telegramBot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
      const media = await MessageMedia.fromUrl(fileLink);
      await whatsappClient.sendMessage(waId, media);
      sent = true;
    } else if (msg.video) {
      const fileLink = await telegramBot.getFileLink(msg.video.file_id);
      const media = await MessageMedia.fromUrl(fileLink);
      await whatsappClient.sendMessage(waId, media);
      sent = true;
    } else if (msg.audio) {
      const fileLink = await telegramBot.getFileLink(msg.audio.file_id);
      const media = await MessageMedia.fromUrl(fileLink);
      await whatsappClient.sendMessage(waId, media);
      sent = true;
    }

    if (sent) {
      sendMessageToTelegram(chatId, "✅ Enviado a WhatsApp.", { message_thread_id: topicId });
      delete pendingReplies[fromId];
    }
  } catch (err) {
    console.error("Error al enviar respuesta a WhatsApp:", err);
    sendMessageToTelegram(chatId, "❌ Error al enviar la respuesta.", {
      message_thread_id: topicId,
    });
    delete pendingReplies[fromId];
  }
});

// --- Inicializar WhatsApp ---
whatsappClient.initialize();

// --- Iniciar servidor Express ---
app.listen(PORT, () => {
  console.log(`Bot corriendo en puerto ${PORT}`);
});
