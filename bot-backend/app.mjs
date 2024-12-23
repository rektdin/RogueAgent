// Load environment variables from .env file
import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server as socketIO } from 'socket.io';
import axios from 'axios';
import cors from 'cors';
import { loadCharacters } from './utils.js';
import { ElevenLabsClient } from "elevenlabs";
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { getTopicFlow } from './characters_pairs/prompts.js'
import { loadVoiceSettings } from './characters_pairs/prompts.js'
// import pg from 'pg';

class ConversationMessage {
    constructor(character_name, content, timestamp = null) {
        this.character_name = character_name;
        this.content = content;
        this.timestamp = timestamp || Date.now();
    }
}


dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new socketIO(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

// PostgreSQL connection configuration
// const pool = new pg.Pool({
//     connectionString: process.env.DATABASE_URL,
// });

// // Test database connection
// pool.connect((err, client, done) => {
//     if (err) {
//         console.error('Error connecting to PostgreSQL:', err);
//     } else {
//         console.log('Successfully connected to PostgreSQL');
//         done();
//     }
// });

app.use(cors());
app.use(express.json());

// Constants
const PORT = process.env.PORT || 5001;

const characters = loadCharacters();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const client = new ElevenLabsClient({
    apiKey: ELEVENLABS_API_KEY,
});

// Global variables
let topicTurnCounter = 0;
let TOPIC_TURNS = 5; // Example constant for topic turn limit
let topicFlowIndex = 0;
let maxRetries = 3;
let topicFlow = getTopicFlow()
let currentTopic = topicFlow[topicFlowIndex];
let conversationActive = false;
let conversationHistory = [];
let activeClients = new Set();
let injectedTopics = [];
const injectionHistory = [];
let injectedCharacters = new Map(); // Map of character name to expiration timestamp

console.log("TOPIC FLOW: ", topicFlow)

function getInitialCharacters() {
    const allCharacters = loadCharacters();
    const characterEntries = Object.entries(allCharacters);
    const initialCharacters = Object.fromEntries(characterEntries.slice(0, 2));
    return initialCharacters;
}

let activeCharacters = getInitialCharacters();

io.on('connection', (socket) => {
    const clientId = socket.id;
    activeClients.add(clientId);
    console.log(`Client connected: ${clientId}, Active clients: ${activeClients.size}`);

    socket.on('disconnect', () => {
        activeClients.delete(clientId);
        console.log(`Client disconnected: ${clientId}, Active clients: ${activeClients.size}`);

        if (activeClients.size === 0) {
            console.log('No active clients, waiting for reconnection...');
            setTimeout(() => {
                if (activeClients.size === 0) {
                    conversationActive = false;
                    console.log('No reconnection, stopping conversation');
                }
            }, 10000); // 10 seconds for potential reconnect
        }
    });

    socket.on('start_conversation', () => {
        conversationHistory = [];
        conversationActive = true;
        console.log('START CONVERSATION');
        generateResponses();
    });

    socket.on('stop_conversation', () => {
        conversationActive = false;
        conversationHistory = [];
        topicTurnCounter = 0;
        io.emit('conversation_stopped');
    });
});


async function generateResponses() {
    let retryCount = 0;

    while (conversationActive) {
        try {
            // Check connection status
            if (activeClients.size === 0) {
                // logger.info("No active clients, waiting...");
                await sleep(3000);
                continue;
            }

            // Construct context from conversation history
            let context = conversationHistory.map(
                (msg) => `${msg.characterName}: ${msg.content}`
            );
            if (!context.length) {
                context = ["Welcome to the Joe Rogan Experience, good to have you here."];
            }

            const characterList = getCharacterNames(characters);
            const characterName = await determineAppropriateCharacter(context, characterList);


            if (!characterName || !(characterName in characters)) {
                await sleep(500);
                continue;
            }

            const character = characters[characterName];
            //   logger.info(`Selected character: ${characterName}`);

            // Generate text response
            let textResponse;
            try {
                const chatMessages = formatChatMessages(character, context);
                textResponse = await generateLLMResponseWithRetry(character, chatMessages);
                conversationHistory.push({ characterName: character.name, content: textResponse });
                console.log(textResponse)
                // logger.info(`Generated text response: ${textResponse.substring(0, 50)}...`);
            } catch (e) {
                // logger.error(`Text generation failed: ${e}`);
                console.log(e)
                continue;
            }

            // Generate audio and emit directly
            let audioData;
            try {
                console.log(textResponse, 2)
                audioData = await generateAudioWithRetry(textResponse, character);
                // logger.info("Generated audio successfully");

                // Emit audio segment directly
                io.emit("audio_segment", audioData);
                // logger.info("Emitted audio segment successfully");

                const newMessage = new ConversationMessage(
                    character.name,
                    textResponse,
                    Date.now() / 1000
                );
                conversationHistory.push(newMessage);
                // logConversation(newMessage);
            } catch (e) {
                // logger.error(`Audio generation or emission failed: ${e}`);
                console.error(e);
                continue;
            }

            // Replace the current topic logic with topic flow logic
            topicTurnCounter++;


            if (topicTurnCounter >= TOPIC_TURNS) {
                topicTurnCounter = 0;
                TOPIC_TURNS = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
                
                // Update topic flow handling to include injected topics
                if (injectedTopics.length > 0) {
                    console.log("INJECTED TOPICS: ", injectedTopics)
                    const nextTopic = injectedTopics.shift();
                    currentTopic = nextTopic.topic;
                    nextTopic.status = 'used';
                    nextTopic.streamTimestamp = Date.now();
                } else {
                    topicFlowIndex = (topicFlowIndex + 1) % topicFlow.length;
                    currentTopic = topicFlow[topicFlowIndex];
                    console.log("CURRENT TOPIC: ", currentTopic)
                    console.log("TOPIC FLOW: ", topicFlow)
                }
            }

            // Add delay between responses
            await sleep(1000);

        } catch (e) {
            //   logger.error(`Error in main generation loop: ${e}`);
            console.error(e);
            await sleep(Math.min(Math.pow(2, retryCount) * 1000, 30000));
            retryCount++;
            if (retryCount > maxRetries) {
                retryCount = 0;
                continue;
            }
        }
    }
}

function getCharacterNames(characters) {
    return Object.keys(characters);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}


async function generateLLMResponseWithRetry(character, messages) {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
        try {
            // Setting OpenAI credentials
            const apiKey = process.env.TOGETHER_API_KEY;
            const apiUrl = "https://api.together.xyz/v1/completions";
            const modelName = "meta-llama/Llama-3-70b-chat-hf";
            const temperature = 0.0;

            // Log messages (similar to log_llm_prompt in Python)

            // Create the payload for the request
            const response = await axios.post(apiUrl, {
                model: modelName,
                temperature: temperature,
                messages: messages,
                max_tokens: 1000
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            // Extract and process the response
            let textResponse = response.data.choices[0].text.trim();

            textResponse = textResponse.replace(`${character.name}: `, "").replace(/"/g, "");

            // Validate response
            if (!textResponse || textResponse.trim().length < 2) {
                console.error("Messages: ", messages);
                console.error("Empty or invalid response received from LLM");
                throw new Error("Empty response from LLM");
            }

            return textResponse;

        } catch (e) {
            retryCount++;
            console.error(`LLM response generation failed (attempt ${retryCount}/${maxRetries}):`, e);

            if (retryCount >= maxRetries) {
                throw e;
            }

            // Adding an exponential backoff for retries
            const delay = Math.min(2 ** retryCount * 1000, 30000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

function formatChatMessages(character, context) {
    const chatMessages = [];

    // Iterate through context and split each message into speaker name and content
    context.forEach((msg) => {
        const parts = msg.split(": ", 2);
        if (parts.length === 2) {
            const [speakerName, content] = parts;

            if (speakerName === "System") {
                chatMessages.push({ role: "system", content });
            } else if (speakerName === character.name) {
                chatMessages.push({ role: "assistant", content });
            } else {
                chatMessages.push({ role: "user", content });
            }
        }
    });

    // Construct system prompt
    const topicPrompt = currentTopic
        ? `\nThe current topic of discussion is: ${currentTopic}.`
        : "";

    const systemPrompt = `
      You are ${character.name}. ${character.name}'s description: ${character.description}
      
      Your message should tie in with the most recent messages sent, but can also contain hilarious unpredictability.${topicPrompt}
      
      Rules:
      1) Only respond as ${character.name}.
      2) Frame your phrasing and messages as close to a podcast as possible. You've been a guest on the Joe Rogan Experience and other world-famous podcasts.
      3) If the last message is from you, ensure your next response moves the conversation forward in an engaging manner.
      4) Do NOT add non conversational messages like *laughs* or *claps* or *nods*, (laughs nervously), (chuckles) etc. DO NOT INCLUDE THEM AT ALL PLEASE.
      7) Make SURE to talk about the current topic and naturally incorporate it into your response.
      8) Keep your responses FUNNY and EDGY. Do not make it too serious and do NOT be woke!
      9) Your response should be concise and limited to 50 words.
      10) Do NOT always mention the other guests' name in your response, especially in further turns.
    `;

    return [{ role: "system", content: systemPrompt.trim() }, ...chatMessages];
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MULTIPLIER = 4000; // starting delay in milliseconds (4 seconds)

export const generateAudioWithRetry = async (text, character) => {
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
        try {
            // Use the appropriate API based on the character
            let data;

            if (character.voiceId === "joe-rogan") {
                // Neets API
                const neetsUrl = "https://api.neets.ai/v1/tts";
                const headers = {
                    "X-API-KEY": process.env.NEETS_API_KEY,
                    "Content-Type": "application/json",
                };

                const payload = {
                    text,
                    voice_id: character.voiceId,
                    params: {
                        model: "ar-diff-50k",
                    },
                };

                const audioResponse = await axios.post(neetsUrl, payload, { headers, responseType: "arraybuffer" });
                if (audioResponse.status !== 200) {
                    console.error(`Audio generation failed: ${audioResponse.data}`);
                    throw new Error(`Failed to generate audio: ${audioResponse.data}`);
                }

                data = audioResponse.data; // Assuming response data contains the audio
            } else {
                // ElevenLabs API
                let voiceSettings = await loadVoiceSettings();
                if (!voiceSettings) {
                    voiceSettings = {
                        stability: 0.5,
                        similarityBoost: 0.8,
                        style: 0.0,
                        useSpeakerBoost: true,
                    };
                } else {
                    voiceSettings = voiceSettings[character.voiceId] || voiceSettings.default;
                }

                const audioStream = await client.generate({
                    voice: character.voiceId || "Rachel",
                    model_id: "eleven_multilingual_v2",
                    text,
                });

                const tempFileName = `${uuidv4()}.mp3`;
                const fileStream = fs.createWriteStream(tempFileName);
                audioStream.pipe(fileStream);

                await new Promise((resolve, reject) => {
                    fileStream.on("finish", () => {
                        console.log("Audio generation complete. File saved as:", tempFileName);
                        resolve();
                    });
                    fileStream.on("error", reject);
                });

                // Read file as buffer data
                data = fs.readFileSync(tempFileName);
            }

            return {
                audio: Buffer.from(data).toString("base64"),
                metadata: {
                    text,
                    character: {
                        name: character.name,
                        avatar_url: character.avatar_url,
                        ...character
                    },
                },
            };
        } catch (error) {
            console.error(`Audio generation failed for text: "${text}" on attempt ${attempts + 1}`);
            console.error(`Error: ${error.message}`);
            attempts++;

            if (attempts < MAX_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempts) * RETRY_DELAY_MULTIPLIER));
            } else {
                throw error;
            }
        }
    }
};


async function determineAppropriateCharacter(context, characterList) {
    console.log('Determining character with:', {
        contextLength: context.length,
        availableCharacters: characterList,
        activeInjections: Array.from(injectedCharacters.entries())
    });

    // Filter out expired injected characters
    const currentTime = Date.now();
    const expiredCharacters = [];
    
    for (const [char, expiration] of injectedCharacters.entries()) {
        if (expiration <= currentTime) {
            expiredCharacters.push(char);
            injectedCharacters.delete(char);
        }
    }
    
    if (expiredCharacters.length > 0) {
        console.log('Removed expired characters:', expiredCharacters);
    }
    
    // Prioritize active injected characters
    const activeInjectedCharacters = Array.from(injectedCharacters.keys());
    console.log('Active injected characters:', activeInjectedCharacters);
    
    if (activeInjectedCharacters.length > 0) {
        const selected = activeInjectedCharacters[Math.floor(Math.random() * activeInjectedCharacters.length)];
        console.log('Selected injected character:', selected);
        return selected;
    }
    
    try {

        const modelName = 'meta-llama/Llama-3-70b-chat-hf';
        const temperature = 0.0;  // Model-specific temperature
        const apiKey = 'b4c6fbea7c99018fcaccc6fe8db6e8192dd8b48b295ad62e82c6d1c2a92d35c8';
        const apiUrl = 'https://api.together.xyz/v1/completions';

        // Check if replying to specific character
        const replyingCharacter = checkLatestReply(context, characterList);
        console.log({ test: replyingCharacter })
        if (replyingCharacter) {
            return replyingCharacter;
        }

        // Prepare context and character list strings
        const contextString = context.join("\n");
        const characterListString = characterList.join(", ");

        // Prepare the system prompt
        const systemPrompt = `
        You are a conversation director who decides which AI character from this character_list: [${characterListString}] responds next in a conversation to keep it moving forward in an engaging manner.
        RULES:
        1) If the last message refers to a specific character, the next response should DEFINITELY be from that character.
        2) Even if the last message refers to someone not in the character_list: [${characterListString}], still respond with someone in the list: [${characterListString}].
        3) Consider the entire conversation to determine your choice.
        Only return 1 item from the list: [${characterListString}] and nothing else.
      `;

        // Prepare chat messages
        const chatMessages = [
            { role: 'system', content: systemPrompt.trim() },
            {
                role: 'user',
                content: `Based on this conversation:\n${contextString}\n\nWho should speak next?`,
            },
        ];

        // logLLMPrompt(chatMessages);

        // Make the API request

        const response = await axios.post(apiUrl, {
            model: modelName,
            messages: chatMessages,
            temperature: temperature,
            max_tokens: 50,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            }
        });

        // Extracting the response text
        const textResponse = response.data.choices[0].text.trim();

        // const response = await axios.post(`${modelParams.api_base}/v1/completions`, {
        //     model: modelParams.name,
        //     messages: chatMessages,
        //     temperature: modelParams.temperature,
        //     max_tokens: 50,
        // }, {
        //     headers: {
        //         'Authorization': `Bearer ${modelParams.api_key}`,
        //         'Content-Type': 'application/json',
        //     }
        // });


        // Extract character name
        const characterName = response.data.choices[0].text.trim();

        if (characterName.toLowerCase() === "none") {
            return null;
        }

        if (characterList.includes(characterName)) {
            return characterName;
        }

        return null;

    } catch (error) {
        console.error(`Error determining appropriate character: ${error.message}`);
        return null;
    }
}


function checkLatestReply(context, characterList) {
    if (!context || context.length === 0) {
        return null;
    }

    // Get the latest message
    const latestMessage = context[context.length - 1];

    for (let characterName of characterList) {
        if (latestMessage.includes(`Replying to ${characterName}`)) {
            return characterName;
        }
    }

    return null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

app.get('/characters', (req, res) => {
    // Clean up expired injected characters
    const currentTime = Date.now();
    for (const [char, expiration] of injectedCharacters.entries()) {
        if (expiration <= currentTime) {
            injectedCharacters.delete(char);
            // Remove character from activeCharacters if injection expired
            if (!Object.keys(getInitialCharacters()).includes(char)) {
                delete activeCharacters[char];
            }
        }
    }

    res.json({
        characters: Object.values(activeCharacters).map(character => ({
            name: character.name,
            avatar_url: character.avatar_url,
            description: character.description,
            isInjected: injectedCharacters.has(character.name),
            injectionExpiresAt: injectedCharacters.get(character.name),
            ...character
        })),
    });
});

app.post('/set_topic', (req, res) => {
    const { topic } = req.body;
    if (topic) {
        currentTopic = topic;
        topicTurnCounter = 0;
    }
    res.json({
        status: 'success',
        topic: currentTopic,
        topicFlow: `Topic_${topicFlowIndex}`,
        topicTurnCounter,
        topicFlowIndex,
    });
});

app.get('/get_topics', (req, res) => {
    res.json({ topics: topicFlow, currentTopic });
});

app.post('/inject_topic', async (req, res) => {
    console.log('Received topic injection request:', req.body);

    const { topic, txHash } = req.body;

    const existingInjection = injectionHistory.find(record => record.txHash === txHash);
    if (existingInjection) {
        return res.status(400).json({
            status: 'error',
            message: 'This transaction has already been used for injection'
        });
    }

    // Fetch transaction details from Solana
    let walletAddress;
    try {
        const response = await fetch('https://aged-clean-dream.solana-mainnet.quiknode.pro/51a78aa7597a179d9adb3aa72df855eff57fc23a', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0
                }]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const txData = await response.json();

        if (txData.error) {
            throw new Error(`Error from Solana RPC: ${txData.error.message}`);
        }

        // Extract wallet address from transaction data
        const signerAccount = txData.result.transaction.message.accountKeys.find(account => 
            account.signer && account.writable
        );
        walletAddress = signerAccount.pubkey;
        console.log('Fetched Wallet Address:', walletAddress);

    } catch (error) {
        console.error('Error fetching transaction:', error);
        return res.status(400).json({
            status: 'error',
            message: 'Invalid transaction hash or error fetching transaction details'
        });
    }

    // Immediately set as current topic
    currentTopic = topic;
    topicTurnCounter = 0;
    
    const topicData = {
        topic,
        walletAddress,
        txHash,
        timestamp: Date.now(),
        status: 'active'
    };
    
    injectedTopics.push(topicData);
    injectionHistory.push({
        type: 'topic_injection',
        ...topicData
    });
    
    // Insert into topic flow right after current index
    topicFlow.splice(topicFlowIndex + 1, 0, topic);
    
    res.json({
        status: 'success',
        message: 'Topic successfully injected and set as current topic',
        data: topicData
    });
});

app.post('/inject_character', async (req, res) => {
    console.log('Received injection request:', req.body);

    const { characterName, txHash } = req.body;

    const existingInjection = injectionHistory.find(record => record.txHash === txHash);
    if (existingInjection) {
        return res.status(400).json({
            status: 'error',
            message: 'This transaction has already been used for injection'
        });
    }

    // Fetch transaction details from Solana
    let walletAddress;
    try {
        const response = await fetch('https://aged-clean-dream.solana-mainnet.quiknode.pro/51a78aa7597a179d9adb3aa72df855eff57fc23a', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0
                }]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const txData = await response.json();

        if (txData.error) {
            throw new Error(`Error from Solana RPC: ${txData.error.message}`);
        }

        // Extract wallet address from transaction data
        const signerAccount = txData.result.transaction.message.accountKeys.find(account => 
            account.signer && account.writable
        );
        walletAddress = signerAccount.pubkey;
        console.log('Fetched Wallet Address:', walletAddress);

    } catch (error) {
        console.error('Error fetching transaction:', error);
        return res.status(400).json({
            status: 'error',
            message: 'Invalid transaction hash or error fetching transaction details'
        });
    }

    const allCharacters = loadCharacters();

    // Validate character exists in all available characters
    if (!allCharacters[characterName]) {
        console.error(`Invalid character requested: ${characterName}`);
        return res.status(400).json({ status: 'error', message: 'Invalid character' });
    }

    // Check if character is already injected
    if (injectedCharacters.has(characterName)) {
        return res.status(400).json({
            status: 'error',
            message: 'This character is already injected'
        });
    }

    const expirationTime = Date.now() + (30 * 60 * 1000); // Fixed 30 minutes duration
    console.log('Setting expiration time:', new Date(expirationTime).toISOString());

    // Add character to active characters if not already present
    if (!activeCharacters[characterName]) {
        activeCharacters[characterName] = allCharacters[characterName];
    }

    // Record the injection in history
    const injectionRecord = {
        type: 'character_injection',
        characterName,
        txHash,
        walletAddress,
        timestamp: Date.now(),
        expirationTime
    };
    injectionHistory.push(injectionRecord);

    injectedCharacters.set(characterName, expirationTime);
    console.log('Current injected characters:',
        Array.from(injectedCharacters.entries()).map(([name, exp]) => ({
            name,
            expiresAt: new Date(exp).toISOString()
        }))
    );

    res.json({
        status: 'success',
        message: 'Character successfully injected',
        data: {
            characterName,
            expirationTime,
            walletAddress,
            txHash,
            injectionRecord
        }
    });
});


app.get('/injection_history', (req, res) => {
    res.json({
        topics: injectedTopics,
        characters: Array.from(injectedCharacters.entries()).map(([name, expiration]) => ({
            name,
            expiration,
            isActive: expiration > Date.now()
        }))
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
