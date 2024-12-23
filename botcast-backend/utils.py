import json
from character_pairs.prompts import return_prompt
import requests
from datetime import datetime

"""
Request to Play AI Network.
{
	"content":{
		"message": "<current character message>",
		"character": "Agent Rogue" | "Kamala Harris",
	},
	"timestamp":"UTC",
	"metadata": {
		"source": "botcast",
		"is_agent_rogue": "true" | "false",
		"guest": "Kamala Harris"
	}
}
"""

rogue_memory_url = "https://rogue-api.playai.network"


def post_to_terminal(message):
    """
    Posts a conversation message to the Play AI terminal.

    Args:
        message (dict): {
            "message": "Hey, have you ever tried DMT?",
            "character": "Agent Rogue"
        }
    """
    payload = {
        "content": {
            "message": message["message"],
            "character": message["character"],
        },
        "timestamp": datetime.now().isoformat(),
        "metadata": {
            "source": "botcast",
            "is_agent_rogue": str(message["character"] == "Agent Rogue"),
            "guest": "Kamala Harris",
        },
    }

    # response = requests.post(f"{rogue_memory_url}/memories", json=payload)
    # print("API RESPONSE DEBUG: ", response.json())


def get_character_names(characters):
    """
    Retrieves the names of characters and returns them as a comma-separated string.

    Args:
        characters (dict): A dictionary of Character objects.

    Returns:
        str: A comma-separated string of character names.
    """
    return list(characters.keys())


# Define your Character class
class Character:
    def __init__(self, name, avatar_url, description, voice_id, mouth_positions):
        self.name = name
        self.avatar_url = avatar_url
        self.description = description
        self.voice_id = voice_id
        self.mouth_positions = mouth_positions


# Load characters from a JSON file
def load_characters():
    try:
        with open("character_pairs/jre_frank_threadguy.json", "r") as f:
            characters_data = json.load(f)
            characters = {}
            for char_name, char_info in characters_data.items():
                characters[char_name] = Character(
                    name=char_info["name"],
                    avatar_url=char_info["avatar_url"],
                    description=return_prompt(char_name),
                    voice_id=char_info["voice_id"],
                    mouth_positions=char_info["mouth_positions"],
                )
            return characters
    except FileNotFoundError:
        # If the file doesn't exist, start with an empty dictionary
        return {}


def check_latest_reply(context, character_list):
    """
    Checks if the latest message contains a reply to any character in the character list.

    Args:
        messages (list): A list of message objects from Discord.
        character_list (list): A list of character names.

    Returns:
        str or None: The name of the character being replied to, or None if no match is found.
    """
    if not context:
        return None

    # Get the latest message
    latest_message = context[-1]
    for character_name in character_list:
        if f"Replying to {character_name}" in latest_message:
            # print(f"Replying to character: {character_name}")
            return character_name

    return None
