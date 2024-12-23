import Database from "better-sqlite3";
import fs from "fs";
import yargs from "yargs";
import askClaude from "./actions/ask_claude.ts";
import follow_room from "./actions/follow_room.ts";
import mute_room from "./actions/mute_room.ts";
import unfollow_room from "./actions/unfollow_room.ts";
import unmute_room from "./actions/unmute_room.ts";
import { SqliteDatabaseAdapter } from "./adapters/sqlite.ts";
import DirectClient from "./clients/direct/index.ts";
import { TelegramClient } from "./clients/telegram/src/index.ts";
import { defaultActions } from "./core/actions.ts";
import defaultCharacter from "./core/defaultCharacter.ts";
import { AgentRuntime } from "./core/runtime.ts";
import settings from "./core/settings.ts";
import { Character, IAgentRuntime } from "./core/types.ts";
import boredomProvider from "./providers/boredom.ts";
import timeProvider from "./providers/time.ts";
import { wait } from "./clients/twitter/utils.ts";
import { TwitterSearchClient } from "./clients/twitter/search.ts";
import { TwitterInteractionClient } from "./clients/twitter/interactions.ts";
import { TwitterGenerationClient } from "./clients/twitter/generate.ts";
import { Coinbase, Wallet } from "@coinbase/coinbase-sdk"; 
import express from 'express';
import { v4 as uuidv4 } from 'uuid'; 
import cors from 'cors';
import OpenAI from "openai";


const openai = new OpenAI({
  baseURL: "https://api.deepinfra.com/v1/openai",
  apiKey: "L7h02pR7PaQPRU1h71QGjuDL6ghkDTqs",
});
const app = express();

 app.use(express.json());
 app.use(cors());
  app.post('/replaceCharacterFile', (req, res) => {
    const { filename, fileContent } = req.body;
    const characterFilePath = `characters/${filename}.json`;
    const jsonData = JSON.parse(fileContent);
    fs.writeFileSync(characterFilePath, JSON.stringify(jsonData, null, 2));
    res.send(`File ${characterFilePath} replaced successfully`);
  });

app.get('/getCharacterFile', (req, res) => {
  const { filename } = req.query;
  const characterFilePath = `characters/${filename}.json`;

  try {
    if (fs.existsSync(characterFilePath)) {
      const fileContent = fs.readFileSync(characterFilePath, 'utf8');
      res.json(JSON.parse(fileContent));
    } else {
      res.status(404).send(`File ${characterFilePath} not found`);
    }
  } catch (error) {
    res.status(500).send(`Error reading file: ${error.message}`);
  }
});
 
app.get('/logs', (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let logFiles = fs.readdirSync('logs');

  const formatLogData = (filename: string, content: string) => {
    const [agentName, , date, taskType] = filename.split(/[_\s,]+/);
    const taskName = taskType.replace('.log', '');

    const parsedContent = content.includes('<POLICY_OVERRIDE>')
      ? "thinking... analyzing"
      : content;

    return JSON.stringify({
      taskId: uuidv4(),  // Generate a new UUID for each log entry
      agentName,
      taskName,
      date: new Date().toISOString(),
      data: parsedContent,
    });
  };

   paginatedLogFiles.forEach((file) => {
    const filePath = `logs/${file}`;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    res.write(`data: ${formatLogData(file, fileContent)}\n\n`);
  });

  const watcher = fs.watch('logs', (eventType, filename) => {
    if (filename) {
      const filePath = `logs/${filename}`;
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        res.write(`data: ${formatLogData(filename, fileContent)}\n\n`);
      }
    }
  });

  req.on("close", () => {
    watcher.close();
  });
});

app.listen(4000, () => {
  console.log(`Server is running at http://localhost:${4000}`);
});

interface Arguments {
  character?: string;
  characters?: string;
  twitter?: boolean;
  discord?: boolean;
  telegram?: boolean;
}

let argv: Arguments = {
  character: "./src/agent/default_character.json",
  characters: "",
};

function getRandomItems<T>(array: T[], numItems: number): T[] {
  const shuffled = array.slice(); // Create a copy of the array to shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); // Random index
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; // Swap elements
  }
  return shuffled.slice(0, numItems); // Return the first 'numItems' elements
}

try {
  argv = yargs(process.argv.slice(2))
    .option("character", {
      type: "string",
      description: "Path to the character JSON file",
    })
    .option("characters", {
      type: "string",
      description: "Comma-separated list of paths to character JSON files",
    })
    .option("telegram", {
      type: "boolean",
      description: "Enable Telegram client",
      default: false,
    })
    .parseSync() as Arguments;
} catch (error) {
  console.log("Error parsing arguments:", error);
}

// Load character
const characterPath = argv.character || argv.characters;
console.log("characterPath", characterPath);

const characterPaths = argv.characters?.split(",").map((path) => path.trim());
console.log("characterPaths", characterPaths);

const characters = [];

const directClient = new DirectClient();
directClient.start(3000);

if (characterPaths?.length > 0) {
  for (const path of characterPaths) {
    try {
      const character = JSON.parse(fs.readFileSync(path, "utf8"));
      console.log("character", character.name);
      characters.push(character);
    } catch (e) {
      console.log(`Error loading character from ${path}: ${e}`);
    }
  }
}

async function setupWallet() {
  const { COINBASE_PROJECT_NAME, COINBASE_PRIVATE_KEY, COINBASE_WALLET_DATA } = process.env;

   console.log("COINBASE_PROJECT_NAME", COINBASE_PROJECT_NAME);
   console.log("COINBASE_PRIVATE_KEY", COINBASE_PRIVATE_KEY);
   console.log("COINBASE_WALLET_DATA", COINBASE_WALLET_DATA);

  if (!COINBASE_PROJECT_NAME || !COINBASE_PRIVATE_KEY) {
    throw new Error("Environment variables COINBASE_PROJECT_NAME or COINBASE_PRIVATE_KEY are not set.");
  }

  const coinbase = new Coinbase({
    apiKeyName: COINBASE_PROJECT_NAME,
    privateKey: COINBASE_PRIVATE_KEY.replaceAll("\\n", "\n"),
  });

  if (COINBASE_WALLET_DATA && COINBASE_WALLET_DATA.length > 0) {
    try {
      const seedFile = JSON.parse(COINBASE_WALLET_DATA);
      const walletIds = Object.keys(seedFile);
      const walletId = getRandomItems(walletIds, 1)[0];
      const seed = seedFile[walletId]?.seed;
      console.log("Importing existing wallet with ID:", walletId);
      return Wallet.import({ seed, walletId });
    } catch (e) {
      console.error("Error importing wallet from COINBASE_WALLET_DATA:", e);
      throw new Error("Failed to import wallet from existing data.");
    }
  } else {
    // Create a new wallet if COINBASE_WALLET_DATA is not provided
    const newWallet: any = await Wallet.create();

    // Extract relevant data from the wallet object
    const walletId = newWallet.model.id || crypto.randomUUID(); // Generate unique walletId if not provided
    const address = newWallet.addresses[0].id; // Main address from wallet addresses array
    const seed = newWallet.seed; // Seed for regenerating wallet

    console.log("New wallet created:", newWallet);

    // Prepare wallet data with the defined walletId, seed, and address
    const walletData = JSON.stringify({
      [walletId]: { seed, address },
    });

    try {
      // Check if .env already has COINBASE_WALLET_DATA and update it
      const envFilePath = ".env";
      const envFileContent = fs.readFileSync(envFilePath, "utf8");

      if (envFileContent.includes("COINBASE_WALLET_DATA")) {
        // Replace existing COINBASE_WALLET_DATA
        const updatedContent = envFileContent.replace(
          /COINBASE_WALLET_DATA=.*/g,
          `COINBASE_WALLET_DATA='${walletData}'`
        );
        fs.writeFileSync(envFilePath, updatedContent, "utf8");
      } else {
        // Append if COINBASE_WALLET_DATA does not exist
        fs.appendFileSync(envFilePath, `\nCOINBASE_WALLET_DATA='${walletData}'\n`);
      }

      console.log("New wallet data saved to environment.");
    } catch (e) {
      console.error("Failed to save wallet data to .env file:", e);
    }

    return newWallet;
  }
}

async function startAgent(character: Character) {
  console.log("Starting agent for character " + character.name);
  const token = character.settings?.secrets?.OPENAI_API_KEY || (settings.OPENAI_API_KEY as string);

  console.log("token", token);
  const db = new SqliteDatabaseAdapter(new Database("./db.sqlite"));
  const wallet = await setupWallet();
  console.log(`Wallet set up for character ${character.name}:`, wallet);

  const runtime = new AgentRuntime({
    databaseAdapter: db,
    token,
    serverUrl: openai.baseURL, // Use DeepInfra's OpenAI base URL
    model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    evaluators: [],
    character,
    providers: [timeProvider, boredomProvider],
    actions: [
      ...defaultActions,
      askClaude,
      follow_room,
      unfollow_room,
      unmute_room,
      mute_room,
    ],
  });
  console.log("runtime", runtime);

  const directRuntime = new AgentRuntime({
    databaseAdapter: db,
    token,
    serverUrl: openai.baseURL, // Use DeepInfra's OpenAI base URL
    model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    evaluators: [],
    character,
    providers: [timeProvider, boredomProvider],
    actions: [...defaultActions],
  });


  async function startTwitter(runtime: IAgentRuntime) {
    console.log("Starting search client");
    const twitterSearchClient = new TwitterSearchClient(runtime);
    await wait();
    console.log("Starting interaction client");
    const twitterInteractionClient = new TwitterInteractionClient(runtime);
    await wait();
    console.log("Starting generation client");
    const twitterGenerationClient = new TwitterGenerationClient(runtime);

    return {
      twitterInteractionClient,
      twitterSearchClient,
      twitterGenerationClient,
    };
  }

  if (!character.clients) {
    return console.error("No clients found for character " + character.name);
  }

  const clients = [];

  // if (argv.telegram || character.clients.map((str) => str.toLowerCase()).includes("telegram")) {
  //   console.log("🔄 Telegram client enabled, starting initialization...");
  //   try {
  //     const botToken = character.settings?.secrets?.TELEGRAM_BOT_TOKEN ?? settings.TELEGRAM_BOT_TOKEN;
  //     if (!botToken) {
  //       throw new Error(`Telegram bot token is not set for character ${character.name}.`);
  //     }

  //     const telegramClient = new TelegramClient(runtime, botToken);
  //     await telegramClient.start();
  //     console.log(`✅ Telegram client successfully started for character ${character.name}`);
  //     clients.push(telegramClient);
  //   } catch (error) {
  //     console.error(`❌ Failed to initialize Telegram client for ${character.name}:`, error);
  //   }
  // }

  if (character.clients.map((str) => str.toLowerCase()).includes("twitter")) {
    const { twitterInteractionClient, twitterSearchClient, twitterGenerationClient } = await startTwitter(runtime);
    clients.push(twitterInteractionClient, twitterSearchClient, twitterGenerationClient);
  }

  directClient.registerAgent(directRuntime);

  return clients;
}

const startAgents = async () => {
  if (characters.length === 0) {
    console.log("No characters found, using default character");
    characters.push(defaultCharacter);
  }
  for (const character of characters) {
    await startAgent(character);
  }
};

startAgents();

import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function chat() {
  rl.question("You: ", async (input) => {
    if (input.toLowerCase() === "exit") {
      rl.close();
      return;
    }

    const agentId = characters[0].name.toLowerCase();
    const response = await fetch(`http://localhost:3000/${agentId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: input,
        userId: "user",
        userName: "User",
      }),
    });

    const data = await response.json();
    console.log(`${characters[0].name}: ${data.text}`);
    chat();
  });
}

console.log("Chat started. Type 'exit' to quit.");
chat();
