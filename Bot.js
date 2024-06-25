const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { Pool } = require('pg');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const token = process.env.TELEGRAM_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const assistantName = 'SilvIA+';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ID del grupo administrativo

// Configuración de la conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Conexión SSL sin validación explícita
  }
});

// Verificar la conexión y crear la tabla "users" si no existe
(async () => {
  try {
    const client = await pool.connect();
    console.log('Conexión exitosa a PostgreSQL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT UNIQUE NOT NULL,
        locale VARCHAR(10) DEFAULT 'es'
      );
    `);
    client.release();
    console.log('Tabla "users" verificada o creada');
  } catch (err) {
    console.error('Error de conexión a PostgreSQL:', err);
  }
})();

// Crear instancia del bot después de haber definido TelegramBot
const bot = new TelegramBot(token, { polling: true });
console.log('Bot iniciado correctamente');

// Almacenamiento temporal para mensajes por chat
const chatMessageHistory = new Map();

// Función para hacer la llamada a OpenAI y cachear respuestas
const cachedResponses = new Map();

async function getChatGPTResponse(messages) {
  const messagesKey = JSON.stringify(messages);
  if (cachedResponses.has(messagesKey)) {
    return cachedResponses.get(messagesKey);
  }

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: messages,
      temperature: 0.7,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      }
    });

    const gptResponse = response.data.choices[0].message.content.trim();
    cachedResponses.set(messagesKey, gptResponse);

    return gptResponse;
  } catch (error) {
    console.error('Error al llamar a OpenAI:', error);
    return 'Lo siento, actualmente no puedo procesar tu solicitud.';
  }
}

// Función para obtener el idioma del usuario desde la base de datos
async function getUserLocale(chatId) {
  try {
    const res = await pool.query('SELECT locale FROM users WHERE chat_id = $1', [chatId]);
    return res.rows.length > 0 ? res.rows[0].locale : 'es';
  } catch (error) {
    console.error('Error al obtener el idioma del usuario:', error);
    return 'es';
  }
}

// Función para actualizar/guardar el idioma del usuario en la base de datos
async function setUserLocale(chatId, locale) {
  try {
    await pool.query('INSERT INTO users (chat_id, locale) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET locale = $2', [chatId, locale]);
  } catch (error) {
    console.error('Error al configurar el idioma del usuario:', error);
  }
}

// Función para determinar si el mensaje es un saludo
function isGreeting(message) {
  const greetings = ['hola', 'hi', 'hello', 'qué tal', 'buenas', 'hey'];
  const normalizedMessage = message.trim().toLowerCase();
  return greetings.includes(normalizedMessage);
}

// Función para determinar si el mensaje es una pregunta por el nombre del asistente
function isAskingName(message) {
  const askingNames = ['¿cuál es tu nombre?', 'cuál es tu nombre?', 'como te llamas?', 'cómo te llamas?', '¿como te llamas?', 'nombre?', 'dime tu nombre'];
  const normalizedMessage = message.trim().toLowerCase();
  return askingNames.includes(normalizedMessage);
}

// Escuchar todos los mensajes entrantes
bot.on('message', async (msg) => {
  try {
    if (!msg || (!msg.text && !msg.voice)) {
      console.error('Mensaje entrante no válido:', msg);
      return;
    }

    const chatId = msg.chat.id;

    if (msg.voice) {
      console.log('Mensaje de voz recibido:', msg.voice);

      const voiceMessageId = msg.voice.file_id;
      const voiceFilePath = await downloadVoiceFile(voiceMessageId);
      const transcription = await transcribeAudio(voiceFilePath);

      console.log('Transcripción del audio:', transcription);

      bot.sendMessage(chatId, transcription);
      // Eliminar el archivo temporal
      fs.unlinkSync(voiceFilePath);
    } else {
      // Mensaje de texto recibido
      console.log('Mensaje de texto recibido:', msg.text);

      // Obtener o inicializar historial de mensajes para este chat
      let messageHistory = chatMessageHistory.get(chatId) || [];

      // Guardar el mensaje actual en el historial
      const userMessage = msg.text;
      messageHistory.push({ role: 'user', content: userMessage });
      chatMessageHistory.set(chatId, messageHistory);

      // Verificar si el mensaje contiene información sobre "Loan"
      const loanKeywords = ['loan', 'niño perdido', 'chico perdido', 'encontrado niño', 'vi a loan', 'se donde esta loan', 'encontre al niño', 'vi al nene', 'el nene esta'];
      const normalizedMessage = msg.text.toLowerCase().trim();

      if (loanKeywords.some(keyword => normalizedMessage.includes(keyword))) {
        // Enviar alerta al grupo administrativo solo si el mensaje contiene frases específicas
        if (normalizedMessage === 'loan' || normalizedMessage === 'loan.') {
          // Caso específico: solo "Loan" sin contexto adicional
          const responseMessage = `¿En qué puedo ayudarte con el tema de los préstamos?`;
          bot.sendMessage(chatId, responseMessage);
        } else {
          // Caso general: frases como "Hemos encontrado a Loan"
          const alertMessage = `🚨 ¡Posible avistamiento del niño perdido! 🚨\n\nMensaje: ${msg.text}`;
          bot.sendMessage(ADMIN_CHAT_ID, alertMessage);
        }
      } else {
        // Saludo detectado u otro tipo de mensaje
        const welcomeMessage = `¡Hola! Soy ${assistantName}, un asistente avanzado. ¿En qué puedo ayudarte?`;
        bot.sendMessage(chatId, welcomeMessage);
      }

      // Otros casos como preguntas por el nombre del asistente, historial, etc.
      if (isAskingName(userMessage)) {
        bot.sendMessage(chatId, assistantName);
      } else if (userMessage.toLowerCase().includes('/historial')) {
        if (messageHistory.length > 0) {
          const conversationHistory = messageHistory.map(m => m.content).join('\n');
          bot.sendMessage(chatId, `Historial de Conversación:\n\n${conversationHistory}`);
        } else {
          bot.sendMessage(chatId, 'No hay historial de conversación disponible.');
        }
      } else {
        // Lógica para manejar solicitud de OpenAI o Wikipedia
        const prompt = { role: 'user', content: userMessage };
        const messages = [...messageHistory, prompt];

        const gptResponse = await getChatGPTResponse(messages);

        if (!gptResponse) {
          const summary = await fetchWikipediaSummary(userMessage);
          bot.sendMessage(chatId, summary || 'No entiendo tu solicitud. ¿Podrías reformularla?');
        } else {
          // Guardar la respuesta de ChatGPT en el historial antes de enviarla
          messageHistory.push({ role: 'assistant', content: gptResponse });
          bot.sendMessage(chatId, gptResponse);
        }
      }
    }
  } catch (error) {
    console.error('Error al procesar el mensaje:', error);
    bot.sendMessage(chatId, 'Ha ocurrido un error al procesar tu mensaje. Por favor, intenta nuevamente más tarde.');
  }
});

// Función para descargar el archivo de voz
async function downloadVoiceFile(fileId) {
  const filePath = `./${fileId}.ogg`; // Ruta local donde se guardará el archivo de voz
  console.log('Descargando archivo de voz. ID:', fileId);

  const fileStream = fs.createWriteStream(filePath);

  try {
    // Obtener detalles del archivo de voz desde Telegram
    const fileDetails = await bot.getFile(fileId);
    console.log('Detalles del archivo:', fileDetails);

    // Verificar el tipo MIME del archivo
    if (fileDetails.file_path.endsWith('.ogg') || fileDetails.file_path.endsWith('.oga')) {
      // Obtener enlace de descarga directa del archivo de voz
      const fileLink = await bot.getFileLink(fileId);
      console.log('Enlace del archivo:', fileLink);

// Función para descargar el archivo de voz
async function downloadVoiceFile(fileId) {
  const filePath = `./${fileId}.ogg`; // Ruta local donde se guardará el archivo de voz
  console.log('Descargando archivo de voz. ID:', fileId);

  const fileStream = fs.createWriteStream(filePath);

  try {
    // Obtener detalles del archivo de voz desde Telegram
    const fileDetails = await bot.getFile(fileId);
    console.log('Detalles del archivo:', fileDetails);

    // Verificar el tipo MIME del archivo
    if (fileDetails.file_path.endsWith('.ogg') || fileDetails.file_path.endsWith('.oga')) {
      // Obtener enlace de descarga directa del archivo de voz
      const fileLink = await bot.getFileLink(fileId);
      console.log('Enlace del archivo:', fileLink);

      // Descargar el archivo de voz utilizando Axios
      const response = await axios({
        url: fileLink,
        method: 'GET',
        responseType: 'stream'
      });

      // Piping para escribir el archivo de voz en el sistema de archivos local
      response.data.pipe(fileStream);

      // Retornar una promesa para manejar la finalización de la descarga
      return new Promise((resolve, reject) => {
        fileStream.on('finish', () => {
          console.log('Archivo descargado correctamente:', filePath);
          resolve(filePath); // Devolver la ruta del archivo descargado
        });
        fileStream.on('error', error => {
          console.error('Error al descargar el archivo de voz:', error);
          reject(error);
        });
      });
    } else {
      throw new Error('El archivo no es compatible. Se esperaba formato OGG.');
    }
  } catch (error) {
    console.error('Error al descargar el archivo de voz:', error);
    throw error; // Lanzar el error para manejarlo en un contexto superior
  }
}

// Función para transcribir audio utilizando Google Cloud Speech API
async function transcribeAudio(filePath) {
  try {
    console.log('Iniciando transcripción de audio. Ruta:', filePath);

    // Configuración del reconocimiento de voz
    const audioConfig = {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'es-ES',
    };

    // Leer el archivo de audio
    const file = fs.readFileSync(filePath);
    console.log('Archivo leído:', file);

    // Realizar la solicitud de transcripción
    const [response] = await speechClient.recognize({
      audio: {
        content: file.toString('base64'),
      },
      config: audioConfig,
    });

    console.log('Respuesta de transcripción:', response);

    // Obtener la transcripción
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    console.log('Transcripción completada:', transcription);

    return transcription;
  } catch (error) {
    console.error('Error al transcribir el audio:', error.message);

    // Manejar específicamente el error de credenciales no cargadas
    if (error.message.includes('Could not load the default credentials')) {
      throw new Error('No se pudieron cargar las credenciales de Google Cloud. Verifica la configuración.');
    }

    throw error; // Lanzar cualquier otro error para manejarlo en un contexto superior
  }
}

// Escuchar el evento de cierre del asistente (simulado)
bot.on('close', (chatId) => {
  clearMessageHistory(chatId);
});

// Escuchar el evento de inicio del bot (/start)
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const opts = {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [{ text: '🇬🇧 English', callback_data: 'en' }],
        [{ text: '🇪🇸 Español', callback_data: 'es' }],
      ],
    }),
  };
  const locale = await getUserLocale(chatId);
  bot.sendMessage(chatId, '¡Hola! Por favor, elige tu idioma.', opts);
});

// Manejar el cambio de idioma desde los botones de selección
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const locale = callbackQuery.data;
  await setUserLocale(chatId, locale);
  bot.sendMessage(chatId, `Idioma cambiado a ${locale}`);
});

// Escuchar errores de polling del bot
bot.on('polling_error', (error) => {
  console.error('Error de polling:', error);
});

// Manejar errores no capturados en el proceso
process.on('uncaughtException', (err) => {
  console.error('Error no capturado:', err);
});

// Manejar rechazos no manejados en promesas
process.on('unhandledRejection', (reason, promise) => {
  console.error('Error no manejado:', reason, 'promise:', promise);
});

// Función para limpiar el historial de mensajes de un chat
function clearMessageHistory(chatId) {
  chatMessageHistory.delete(chatId);
}

console.log('Bot iniciado correctamente');
