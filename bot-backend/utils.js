const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { returnPrompt } = require('./characters_pairs/prompts');
const { formatISO } = require('date-fns');

const rogueMemoryUrl = "https://rogue-api.playai.network";

/**
 * Posts a conversation message to the Play AI terminal.
 * 
 * @param {Object} message - {
 *   message: "Hey, have you ever tried DMT?",
 *   character: "Agent Rogue"
 * }
 */
const postToTerminal = async (message) => {
  const payload = {
    content: {
      message: message.message,
      character: message.character,
    },
    timestamp: formatISO(new Date()), // ISO 8601 format
    metadata: {
      source: "botcast",
      is_agent_rogue: message.character === "Agent Rogue" ? "true" : "false",
      guest: "Kamala Harris",
    },
  };

  try {
    const response = await axios.post(`${rogueMemoryUrl}/memories`, payload);
    console.log("API RESPONSE DEBUG: ", response.data);
  } catch (error) {
    console.error("Error posting to terminal:", error.message);
  }
};

/**
 * Retrieves the names of characters and returns them as an array.
 * 
 * @param {Object} characters - A dictionary of Character objects.
 * @returns {Array} An array of character names.
 */
const getCharacterNames = (characters) => {
  return Object.keys(characters);
};

// Define your Character class
class Character {
  constructor(name, avatarUrl, description, voiceId, mouthPositions) {
    this.name = name;
    this.avatar_url = avatarUrl;
    this.description = description;
    this.voiceId = voiceId;
    this.mouth_positions = mouthPositions;
  }
}

/**
 * Load characters from a JSON file.
 * @returns {Object} A dictionary of Character objects.
 */
const loadCharacters = () => {
  const characterFilePath = path.join(__dirname, 'characters_pairs/jre_frank_threadguy.json');
  let characters = {};

  const updateCharacters = () => {
    try {
      const charactersData = JSON.parse(fs.readFileSync(characterFilePath, 'utf8'));
      const updatedCharacters = {};

      console.log(charactersData)

      for (const [charName, charInfo] of Object.entries(charactersData)) {
        updatedCharacters[charName] = new Character(
          charInfo.name,
          charInfo.avatar_url,
          returnPrompt(charName),
          charInfo.voice_id,
          charInfo.mouth_positions
        );
      }

      characters = updatedCharacters;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return an empty object
        characters = {};
      } else {
        console.error("Error loading characters:", error.message);
      }
    }
  };

  updateCharacters(); // Initial update

  // Set up file watcher to listen for changes
  const watcher = fs.watch(characterFilePath, () => {
    console.log('Characters file changed, updating...');
    updateCharacters();
  });

  return characters;
};

/**
 * Checks if the latest message contains a reply to any character in the character list.
 * 
 * @param {Array} context - A list of message objects from Discord.
 * @param {Array} characterList - A list of character names.
 * @returns {String|null} The name of the character being replied to, or null if no match is found.
 */
const checkLatestReply = (context, characterList) => {
  if (!context || context.length === 0) {
    return null;
  }

  // Get the latest message
  const latestMessage = context[context.length - 1];
  for (const characterName of characterList) {
    if (latestMessage.includes(`Replying to ${characterName}`)) {
      console.log(`Replying to character: ${characterName}`);
      return characterName;
    }
  }

  return null;
};

module.exports = {
  postToTerminal,
  getCharacterNames,
  loadCharacters,
  checkLatestReply,
};
