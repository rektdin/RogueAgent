from typing import Optional, List, Dict
from queue import Queue
from flask import jsonify, request
from utils import (
    Character,
    get_character_names,
    check_latest_reply,
    load_characters,
)
import traceback
from flask import Flask
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from openai import OpenAI
import time
import base64
import json
import requests
from tenacity import retry, stop_after_attempt, wait_exponential
import logging
from utils import post_to_terminal
import threading
from character_pairs.prompts import get_topic_flow
import threading
import random
from elevenlabs import VoiceSettings
from elevenlabs.client import ElevenLabs

# TODO: Move environment variables to .env file˚
ELEVENLABS_API_KEY=""

elevenlabs_client = ElevenLabs(
    api_key=ELEVENLABS_API_KEY,
)

# Modify global variables at the top

topic_turn_counter: int = 0
TOPIC_TURNS = 5  # Changed from TOPIC_MAX_TURNS to match new requirement
topic_flow = get_topic_flow()
topic_flow_index = 0  # Add this to track position in topic flow

current_topic: Optional[str] = topic_flow[0]
app = Flask(__name__)
CORS(app)
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    ping_timeout=120,  # Increase timeout
    ping_interval=15,  # More frequent pings
    max_http_buffer_size=1e8,  # Larger buffer for audio
    async_mode="threading",  # Use threading mode
    reconnection=True,
    reconnection_attempts=10,
    reconnection_delay=1000,
    reconnection_delay_max=5000,
)

# Track active clients
active_clients = set()

# Initialize OpenAI client
# client = OpenAI()

characters = load_characters()

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ConversationMessage:
    def __init__(self, character_name: str, content: str, timestamp: float = None):
        self.character_name = character_name
        self.content = content
        self.timestamp = timestamp or time.time()


@socketio.on("connect")
def handle_connect():
    client_id = request.sid
    active_clients.add(client_id)
    logger.info(
        f"Client connected. ID: {client_id}. Active clients: {len(active_clients)}"
    )


@socketio.on("disconnect")
def handle_disconnect():
    client_id = request.sid
    if client_id in active_clients:
        active_clients.remove(client_id)
    logger.info(
        f"Client disconnected. ID: {client_id}. Active clients: {len(active_clients)}"
    )

    # Don't stop conversation immediately
    if not active_clients:
        logger.info("No active clients, waiting for reconnection...")
        time.sleep(10)  # Wait longer for potential reconnect
        if not active_clients:
            global conversation_active
            conversation_active = False
            logger.info("No reconnection, stopping conversation")


@socketio.on("start_conversation")
def handle_start():
    global conversation_history, conversation_active, generator_thread
    conversation_history = []
    conversation_active = True
    print("START CONVERSATION")

    # Start the queue processing thread
    # generator_thread = threading.Thread(target=process_queue)
    # generator_thread.daemon = (
    #     True  # Make thread daemon so it exits when main program exits
    # )
    # generator_thread.start()

    generate_responses()


def set_openai_credentials(model_name):
    """
    Set OpenAI API key and base URL based on the model name.
    """
    global name, temp, client

    model_params = {
        "airoboros": {
            "name": "deepinfra/airoboros-70b",
            "temperature": 0.5,
            "api_key": "",
            "api_base": "https://api.deepinfra.com/v1/openai",
        },
        "mixtral": {
            "name": "nousresearch/nous-hermes-2-mixtral-8x7b-dpo",
            "temperature": 0.8,
            "api_key": "",
            "api_base": "https://openrouter.ai/api/v1",
        },
        "noromaid": {
            "name": "neversleep/noromaid-mixtral-8x7b-instruct",
            "temperature": 0.8,
            "api_key": "",
            "api_base": "https://openrouter.ai/api/v1",
        },
        "mythomax": {
            "name": "TheBloke/MythoMax-L2-13B-AWQ",
            "temperature": 0.8,
            "api_key": "EMPTY",
            "api_base": "http://194.68.245.11:22169/v1",
        },
        "llama": {
            "name": "meta-llama/Llama-3-70b-chat-hf",
            "temperature": 0.0,
            "api_key": "",
            "api_base": "https://api.together.xyz",
        },
        "llamalite": {
            "name": "meta-llama/Meta-Llama-3-70B-Instruct-Lite",
            "temperature": 0.0,
            "api_key": "",
            "api_base": "https://api.together.xyz",
        },
        "llama3.1": {
            "name": "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
            "temperature": 0.5,
            "api_key": "",
            "api_base": "https://api.together.xyz",
        },
        "llama3.2": {
            "name": "meta-llama/Llama-3.2-3B-Instruct-Turbo",
            "temperature": 0.2,
            "api_key": "",
            "api_base": "https://api.together.xyz",
        },
        "nemo": {
            "name": "mistralai/Mistral-Nemo-Instruct-2407",
            "temperature": 0.9,
            "api_key": "",
            "api_base": "https://api.deepinfra.com/v1/openai",
        },
        "3.1_405": {
            "name": "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
            "temperature": 0.2,
            "api_key": "",
            "api_base": "https://api.together.xyz",
        },
    }

    client = OpenAI(
        api_key=model_params[model_name]["api_key"],
        base_url=model_params[model_name]["api_base"],
    )
    name = model_params[model_name]["name"]
    temp = model_params[model_name]["temperature"]


def generate_chat_response(messages):
    response = client.chat.completions.create(
        model=name,
        messages=messages,
    )
    return response.choices[0].message.content.strip()


def add_new_topic(messages):
    global topic_flow
    try:
        set_openai_credentials("llama")
        response = client.chat.completions.create(
            model=name,
            messages=messages,
        )
        # replace starting and ending quotes
        topic = response.choices[0].message.content.strip()
        print("New topic generated: ", topic)
        if topic not in topic_flow:
            topic_flow.append(topic)
    except Exception as e:
        logger.error(f"Error adding new topic: {e}")
        pass


def check_and_add_new_topic():
    global topic_flow, topic_flow_index

    new_topic_prompt = f"""Given the following topics for the podcast between {",".join(characters.keys())}. Generate a new topic. The topic should be interesting and should drive engaging conversation.  
    Topic should be unique and concise. Do not generate topics that are too similar to the existing topics. 
    Do not generate topics that are similar to last 5 topics.
    You should only return the new topic and nothing else.
    Do not include quotes in preceding or following the topic.
    
    topics: {random.sample(topic_flow, 5)}
    
    Here is the next topic for the podcast:"""

    if len(topic_flow) - topic_flow_index < 5:
        print("Adding new topic")
        add_new_topic([{"role": "system", "content": new_topic_prompt}])
    threading.Timer(5.0, check_and_add_new_topic).start()


# check_and_add_new_topic()


def generate_responses():
    """Generate responses and stream audio with error handling"""
    global conversation_active, topic_turn_counter, current_topic, topic_flow_index, conversation_history, TOPIC_TURNS
    retry_count = 0
    max_retries = 3

    while conversation_active:
        try:
            # Check connection status
            if not active_clients:
                logger.info("No active clients, waiting...")
                time.sleep(3)
                continue

            context = [
                f"{msg.character_name}: {msg.content}" for msg in conversation_history
            ]
            if not context:
                context = [
                    "Welcome to the Joe Rogan Experience, good to have you here."
                ]

            character_list = get_character_names(characters)
            character_name = determine_appropriate_character(context, character_list)

            if not character_name or character_name not in characters:
                time.sleep(0.5)
                continue

            character = characters[character_name]
            logger.info(f"Selected character: {character_name}")

            # Generate text response
            try:
                chat_messages = format_chat_messages(character, context)
                text_response = generate_llm_response_with_retry(
                    character, chat_messages
                )
                logger.info(f"Generated text response: {text_response[:50]}...")
            except Exception as e:
                logger.error(f"Text generation failed: {e}")
                continue
            # Post message to Play AI terminal
            # post_to_terminal({"message": text_response, "character": character_name})
            # Generate audio and emit directly
            try:
                audio_data = generate_audio_with_retry(text_response, character)
                logger.info("Generated audio successfully")

                # Emit audio segment directly
                socketio.emit(
                    "audio_segment",
                    audio_data,
                )
                logger.info("Emitted audio segment successfully")

                # Add to conversation history
                new_message = ConversationMessage(
                    character_name=character.name,
                    content=text_response,
                    timestamp=time.time(),
                )
                conversation_history.append(new_message)
                log_conversation(new_message)

            except Exception as e:
                logger.error(f"Audio generation or emission failed: {e}")
                traceback.print_exc()
                continue

            # Replace the current topic logic with topic flow logic
            topic_turn_counter += 1
            print("Topic turn counter: ", topic_turn_counter)

            if topic_turn_counter >= TOPIC_TURNS:
                topic_turn_counter = 0
                TOPIC_TURNS = random.randint(5, 10)
                topic_flow_index = (topic_flow_index + 1) % len(topic_flow)
                current_topic = topic_flow[topic_flow_index]
                logger.info(f"Switching to new topic: {current_topic}")
                # Cull conversation history when switching topics
                conversation_history = []

            # Add delay between responses
            time.sleep(1)

        except Exception as e:
            logger.error(f"Error in main generation loop: {e}")
            traceback.print_exc()
            time.sleep(min(2 ** retry_count, 30))
            retry_count += 1
            if retry_count > max_retries:
                retry_count = 0
                continue


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
def generate_llm_response_with_retry(
        character: Character, messages: List[Dict[str, str]]
) -> str:
    """Generate response using OpenAI with retry logic"""
    try:
        set_openai_credentials("llama")
        log_llm_prompt(messages)
        response = client.chat.completions.create(
            model=name,
            temperature=temp,
            messages=messages,
            max_tokens=1000,
        )
        text_response = (
            response.choices[0]
            .message.content.strip()
            .replace(f"{character.name}: ", "")
            .replace('"', "")
        )

        # Validate response
        if not text_response or len(text_response.strip()) < 2:
            print("Messages", messages)
            print("Empty or invalid response received from LLM")
            raise Exception("Empty response from LLM")

        return text_response
    except Exception as e:
        print(f"LLM response generation failed: {e}")
        raise  # Let retry decorator handle it


# Retry audio generation
@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
def generate_audio_with_retry(text: str, character: Character) -> dict:
    """Generate audio and return data instead of emitting directly"""
    try:

        data = b""

        if character.voice_id == "joe-rogan":
            # Neets API
            neets_url = "https://api.neets.ai/v1/tts"
            headers = {
                "X-API-KEY": "",
                "Content-Type": "application/json",
            }

            payload = {
                "text": text,
                "voice_id": character.voice_id,
                "params": {
                    "model": "ar-diff-50k",
                },
            }

            logger.info(f"Generating audio for: {text[:30]}...")
            audio_response = requests.post(neets_url, json=payload, headers=headers)
            data = audio_response.content

            if audio_response.status_code != 200:
                logger.error(f"Audio generation failed: {audio_response.text}")
                raise Exception(f"Failed to generate audio: {audio_response.text}")
        else:
            # ElevenLabs API
            voice_settings = VoiceSettings(
                stability=0.5,
                similarity_boost=0.8,
                style=0.0,
                use_speaker_boost=True,
            )

            if character.voice_id == "x86uQqNKUBgPBwbii6G0":
                voice_settings = VoiceSettings(
                    stability=0.8,
                    similarity_boost=0.7,
                    style=0.3,
                    use_speaker_boost=True,
                )


            audio_response = elevenlabs_client.text_to_speech.convert(
                voice_id=character.voice_id, # Adam pre-made voice
                output_format="mp3_22050_32",
                text=text,
                model_id="eleven_multilingual_v2", # use the turbo model for low latency
                voice_settings=voice_settings,
            )

            data = b""
            for chunk in audio_response:
                if chunk:
                    data += chunk

        return {
            "audio": base64.b64encode(data).decode("utf-8"),
            "metadata": {
                "text": text,
                "character": {
                    "name": character.name,
                    "avatar_url": character.avatar_url,
                },
            },
        }

    except Exception as e:
        logger.error(f"Audio generation failed for text: {text}")
        logger.error(f"Error: {e}")
        raise


@socketio.on("stop_conversation")
def handle_stop():
    global conversation_active, conversation_history, topic_turn_counter
    conversation_active = False
    conversation_history = []  # Clear history if desired
    current_topic = topic_flow[0]
    topic_turn_counter = 0  # Reset counter but keep current topic
    emit("conversation_stopped")


def determine_appropriate_character(
        context: List[str], character_list: List[str]
) -> Optional[str]:
    """
    Determines the most appropriate character to respond based on conversation context.
    """
    # Check if last message is from System
    # if context and "System:" in context[-1]:
    #     print("System message detected, returning Agent Rogue")
    #     return "Agent Rogue"

    set_openai_credentials("llama3.1")

    # Check if replying to specific character
    replying_character = check_latest_reply(context, character_list)
    if replying_character:
        print("Referenced character chosen:", replying_character)
        return replying_character

    context_string = "\n".join(context)
    character_list_string = ", ".join(character_list)

    system_prompt = f"""You are a conversation director who decides which AI character from this character_list: [{character_list_string}] responds next in a conversation to keep it moving forward in an engaging manner. 
    RULES:
    1) If the last message refers to a specific character, the next response should DEFINITELY be from that character.
    2) Even if the last message refers to someone not in the character_list: [{character_list_string}], still respond with someone in the list: [{character_list_string}].
    3) Consider the entire conversation to determine your choice.
      Only return 1 item from the list: [{character_list_string}] and nothing else.
    """

    try:
        chat_messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": f"Based on this conversation:\n{context_string}\n\nWho should speak next?",
            },
        ]

        log_llm_prompt(chat_messages)

        response = client.chat.completions.create(
            model=name,
            messages=chat_messages,
            temperature=temp,
            max_tokens=50,
        )

        character_name = response.choices[0].message.content.strip()
        print("Character name determined: ", character_name)
        if character_name.lower() == "none":
            return None

        if character_name in character_list:
            return character_name

        return None

    except Exception as e:
        print(f"Error determining appropriate character: {e}")
        return None


@app.route("/characters", methods=["GET"])
def get_characters():
    """Get the list of characters"""
    return jsonify(
        {
            "characters": [
                {
                    "name": character.name,
                    "avatar_url": character.avatar_url,
                    "description": character.description,
                    "mouth_positions": character.mouth_positions,
                }
                for character in characters.values()
            ]
        }
    )


@app.route("/set_topic", methods=["POST"])
def set_topic():
    """Set the current conversation topic"""
    global topic_flow
    data = request.json
    new_topic = data.get("topic")

    # Add new topic to the flow if it's not already there
    if new_topic not in topic_flow:
        topic_flow.insert(topic_flow_index + 1, new_topic)

    topic_turn_counter = 0  # Reset counter when new topic is set

    return jsonify(
        {
            "status": "success",
            "topic": current_topic,
            "topic_flow": topic_flow,
            "topic_turn_counter": topic_turn_counter,
            "topic_flow_index": topic_flow_index,
            # Optionally return the updated flow
        }
    )


@app.route("/get_topics", methods=["GET"])
def get_topics():
    """Get the list of topics"""
    return jsonify({"topics": topic_flow, "current_topic": current_topic})


def format_chat_messages(
        character: Character, context: List[str]
) -> List[Dict[str, str]]:
    """Format messages for OpenAI chat completion"""

    chat_messages = []
    for msg in context:
        parts = msg.split(": ", 1)
        if len(parts) == 2:
            speaker_name, content = parts
            if speaker_name == "System":
                chat_messages.append({"role": "system", "content": content})
            elif speaker_name == character.name:
                chat_messages.append({"role": "assistant", "content": content})
            else:
                chat_messages.append({"role": "user", "content": content})

    topic_prompt = (
        f"\nThe current topic of discussion is: {current_topic}."
        if current_topic
        else ""
    )

    system_prompt = f"""
    You are {character.name}. {character.name}'s description: {character.description}
    
    You are in a podcast with the following other guests: {', '.join([name for name in get_character_names(characters) if name != character.name])}. 
    Your message should tie in with the most recent messages sent, but can also contain hilarious unpredictability.{topic_prompt}
    
    Rules:
    1) Only respond as {character.name}.
    2) Frame your phrasing and messages as close to a podcast as possible. You've been a guest on the Joe Rogan Experience and other world famous podcasts.
    3) If the last message is from you, ensure your next response moves the conversation forward in an engaging manner.
    4) Do NOT add non conversational messages like *laughs* or *claps* or *nods*, (laughs nervously), (chuckles) etc. DO NOT INCLUDE THEM AT ALL PLEASE
    7) Make SURE to talk about the current topic and naturally incorporate it into your response.
    8) Keep your responses FUNNY and EDGY. Do not make it too serious and do NOT be woke!
    9) Your response should be concise and limited to 50 words.
    10) Do NOT always mention the other guests name in your response especially in further turns
    """

    return [{"role": "system", "content": system_prompt}, *chat_messages]


def generate_audio(character: Character, text: str) -> str:
    """Generate audio using Neets TTS"""
    try:
        neets_url = "https://api.neets.ai/v1/tts"
        headers = {
            "X-API-KEY": "",
            "Content-Type": "application/json",
        }

        payload = {
            "text": text,
            "voice_id": character.voice_id,
            "params": {"model": "ar-diff-50k"},
        }

        print("Requesting audio generation from Neets...")
        audio_response = requests.post(neets_url, json=payload, headers=headers)
        print("Audio response status:", audio_response.status_code)

        if audio_response.status_code != 200:
            print("Audio generation failed:", audio_response.text)
            raise Exception("Failed to generate audio")

        return base64.b64encode(audio_response.content).decode("utf-8")

    except Exception as e:
        print(f"Error generating audio: {e}")
        raise e


def process_queue():
    """Process and emit responses from the queue"""
    global conversation_active, response_queue, conversation_history
    print("PROCESSING QUEUE")
    while conversation_active:
        try:
            if not response_queue.empty():
                response_data = response_queue.get()

                # Create conversation message and log it without culling
                new_message = ConversationMessage(
                    character_name=response_data["character"]["name"],
                    content=response_data["message"],
                    timestamp=time.time(),
                )
                conversation_history.append(new_message)
                log_conversation(new_message)

                # Emit to client with audio data
                socketio.emit(
                    "new_response",
                    {
                        "character": response_data["character"],
                        "message": response_data["message"],
                        "audio": response_data[
                            "audio"
                        ],  # This is the base64 audio data
                    },
                )
                print("SENDING AUDIO DATA TO BACKEND")
                # Add delay between responses
                time.sleep(0.5)
            else:
                print("RESPONSE QUEUE EMPTY")
                time.sleep(0.1)

        except Exception as e:
            print(f"Error processing queue: {e}")
            socketio.emit("error", {"message": str(e)})
            time.sleep(0.5)


def log_llm_prompt(messages: List[Dict[str, str]]) -> None:
    """Log the prompt being sent to the LLM"""
    with open("llm_prompt.log", "w") as f:
        f.write(str(messages))


def log_conversation(message: ConversationMessage) -> None:
    """Log conversation messages to JSON file"""
    log_entry = {
        "character_name": message.character_name,
        "message": message.content,
        "timestamp": message.timestamp,
    }

    try:
        # Read existing logs
        try:
            with open("conversation.json", "r") as f:
                logs = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            logs = []

        # Append new entry
        logs.append(log_entry)

        # Write updated logs
        with open("conversation.json", "w") as f:
            json.dump(logs, f, indent=2)
    except Exception as e:
        print(f"Error logging conversation: {e}")


def emit_with_retry(event, data, max_retries=3):
    """Emit with retry logic and connection check"""
    for attempt in range(max_retries):
        try:
            if active_clients:
                socketio.emit(event, data)
                return True
            else:
                logger.warning("No active clients for emit")
                time.sleep(2)
        except Exception as e:
            logger.error(f"Emit failed (attempt {attempt + 1}/{max_retries}): {e}")
            time.sleep(1)
    return False


if __name__ == "__main__":
    socketio.run(app, debug=True)
