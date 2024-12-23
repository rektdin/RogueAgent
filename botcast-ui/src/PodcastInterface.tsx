import {Box, IconButton, Sheet, Typography, Avatar} from "@mui/joy";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import PowerSettingsNewIcon from "@mui/icons-material/PowerSettingsNew";
import CircularProgress from "@mui/joy/CircularProgress";
import {useState, useEffect, useRef} from "react";
import {io} from "socket.io-client";

const API_URL = "http://127.0.0.1:5001";
const socket = io(API_URL);

const MOUTH_STATES = {
    "10": "10",
    "20": "20",
    "30": "30",
    "40": "40"
};

type AudioSegment = {
    audio: ArrayBuffer;
    text: string;
    character: Character;
    startTime: number;
    duration: number;
};

type Character = {
    name: string;
    avatar_url: string;
    description: string;
    mouth_positions: {
        [key in typeof MOUTH_STATES[keyof typeof MOUTH_STATES]]: string;
    };
};


export function PodcastInterface() {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentText, setCurrentText] = useState("");
    const [currentCharacter, setCurrentCharacter] = useState<Character | null>(null);
    const [currentMouthState, setCurrentMouthState] = useState(MOUTH_STATES[50]);

    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const currentSourceNode = useRef<AudioBufferSourceNode | null>(null);
    const animationFrameRef = useRef<number>();
    const audioBufferQueue = useRef<Array<{
        buffer: AudioBuffer;
        text: string;
        character: Character;
    }>>([]);
    const isProcessingQueue = useRef(false);

    // Function to get mouth state based on audio intensity
    const getMouthState = (intensity: number): string => {
        if (intensity < 0.08) return MOUTH_STATES["10"];
        if (intensity < 0.12) return MOUTH_STATES["20"];
        if (intensity < 0.20) return MOUTH_STATES["30"];
        return MOUTH_STATES["40"];
    };

    // Function to analyze audio and update mouth state
    const analyzeAudio = () => {
        if (!analyserRef.current) return;

        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);

        // Calculate average intensity
        const average = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;
        const normalizedIntensity = average / 255;

        // Update mouth state based on intensity
        setCurrentMouthState(getMouthState(normalizedIntensity));

        // Continue animation loop
        setTimeout(analyzeAudio, 60);
    };

    useEffect(() => {
        const pollCharacters = () => {
            fetch(`${API_URL}/characters`)
                .then((res) => res.json())
                .then((data) => {
                    setCharacters(data.characters);
                    setTimeout(pollCharacters, 5000); // Poll every 5 seconds
                })
                .catch((error) => {
                    console.error("Error fetching characters:", error);
                    setTimeout(pollCharacters, 5000); // Retry after 5 seconds
                });
        };

        pollCharacters();

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, []);

    useEffect(() => {
        socket.on("audio_segment", async (data) => {
            try {
                if (!audioContextRef.current || audioContextRef.current.state === "closed") {
                    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
                    analyserRef.current = audioContextRef.current.createAnalyser();
                    analyserRef.current.fftSize = 256;
                }

                // Convert and decode audio
                const binaryString = window.atob(data.audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                const audioBuffer = await audioContextRef.current.decodeAudioData(bytes.buffer.slice(0));

                audioBufferQueue.current.push({
                    buffer: audioBuffer,
                    text: data.metadata.text,
                    character: data.metadata.character,
                });

                if (isPlaying && !isProcessingQueue.current) {
                    processQueue();
                }
            } catch (error) {
                console.error("Error processing audio segment:", error);
            }
        });

        return () => {
            socket.off("audio_segment");
        };
    }, [isPlaying]);

    const processQueue = async () => {
        if (!audioContextRef.current || audioBufferQueue.current.length === 0 || !isPlaying) {
            isProcessingQueue.current = false;
            return;
        }

        isProcessingQueue.current = true;
        const segment = audioBufferQueue.current[0];

        try {
            setCurrentText(segment.text);
            setCurrentCharacter(segment.character);

            const source = audioContextRef.current.createBufferSource();
            source.buffer = segment.buffer;

            // Connect source to analyzer and then to destination
            source.connect(analyserRef.current!);
            analyserRef.current!.connect(audioContextRef.current.destination);

            if (currentSourceNode.current) {
                currentSourceNode.current.stop();
                currentSourceNode.current.disconnect();
            }

            currentSourceNode.current = source;

            // Start audio analysis
            analyzeAudio();

            await new Promise<void>((resolve) => {
                source.onended = () => {
                    audioBufferQueue.current.shift();
                    // Reset mouth state when audio ends
                    setCurrentMouthState(MOUTH_STATES.CLOSED);
                    resolve();
                };
                source.start(0);
            });

            processQueue();
        } catch (error) {
            console.error("Error playing audio:", error);
            isProcessingQueue.current = false;
        }
    };

    const handleStart = () => {
        console.log("Start clicked");
        setIsPlaying(true);
        socket.emit("start_conversation");
    };

    const handlePlay = async () => {
        if (
            !audioContextRef.current ||
            audioContextRef.current.state === "closed"
        ) {
            audioContextRef.current = new (window.AudioContext ||
                window.webkitAudioContext)();
        }

        if (audioContextRef.current.state === "suspended") {
            await audioContextRef.current.resume();
        }

        setIsPlaying(true);
        if (!isProcessingQueue.current) {
            processQueue();
        }
    };

    const handlePause = () => {
        setIsPlaying(false);
        if (currentSourceNode.current) {
            currentSourceNode.current.stop();
        }
    };

    const handleStop = () => {
        setIsPlaying(false);
        isProcessingQueue.current = false;
        audioBufferQueue.current = [];
        if (currentSourceNode.current) {
            currentSourceNode.current.stop();
            currentSourceNode.current.disconnect();
        }
        setCurrentText("");
        setCurrentCharacter(null);
        socket.emit("stop_conversation");
    };

    return (
        <Sheet
            sx={{
                display: "flex",
                flexDirection: "column",
                height: "100vh",
                width: "100vw",
                p: 2,
                gap: 2,
            }}
        >
            <Box sx={{display: "flex", flex: 1, width: "100%", gap: 2, p: 2, flexWrap: "wrap"}}>
                {characters.length === 0 ? (
                    <Box sx={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        flex: 1,
                        gap: 2
                    }}>
                        <CircularProgress size="lg"/>
                        <Typography level="h3">Botcasts loading soon...</Typography>
                    </Box>
                ) : (
                    <Box sx={{
                        display: "grid",
                        gridTemplateColumns: {
                            xs: "1fr",
                            sm: characters.length === 2 ? "1fr 1fr" : "repeat(auto-fit, minmax(250px, 1fr))",
                            md: characters.length <= 3 ? `repeat(${characters.length}, 1fr)` : "repeat(auto-fit, minmax(300px, 1fr))",
                        },
                        gap: 2,
                        width: "100%",
                        height: "100%",
                    }}>
                        {characters.map((character) => (
                            <Sheet
                                key={character.name}
                                variant="outlined"
                                sx={{
                                    position: "relative",
                                    borderRadius: "md",
                                    height: characters.length <= 4 ? "100%" : "300px",
                                    overflow: "hidden",
                                    borderColor: currentCharacter?.name === character.name ? "#ff9800" : "#e0e0e0",
                                    transition: "border-color 0.3s ease",
                                    backgroundImage: `url(${currentCharacter?.name === character.name
                                        ? character.mouth_positions[currentMouthState]
                                        : character.avatar_url
                                    })`,
                                    backgroundSize: "cover",
                                    backgroundPosition: "center",
                                }}
                            >
                                <Box
                                    sx={{
                                        position: "absolute",
                                        bottom: 0,
                                        left: 0,
                                        right: 0,
                                        background:
                                            "linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0))",
                                        padding: 3,
                                        minHeight: "40%",
                                        display: "flex",
                                        flexDirection: "column",
                                        justifyContent: "flex-end",
                                    }}
                                >
                                    <Typography
                                        level="h4"
                                        sx={{
                                            color: "white",
                                            mb: 2,
                                            textShadow: "2px 2px 4px rgba(0,0,0,0.5)",
                                        }}
                                    >
                                        {character.name}
                                    </Typography>
                                    <Typography
                                        level="body-lg"
                                        sx={{
                                            color: "white",
                                            textShadow: "1px 1px 2px rgba(0,0,0,0.5)",
                                            opacity:
                                                currentCharacter?.name === character.name ? 1 : 0,
                                            transition: "opacity 0.3s ease",
                                        }}
                                    >
                                        {currentCharacter?.name === character.name
                                            ? currentText
                                            : ""}
                                    </Typography>
                                </Box>
                            </Sheet>
                        ))}
                    </Box>
                )}
            </Box>
            {/* Controls */}
            <Sheet
                variant="outlined"
                sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 2,
                    p: 3,
                    borderRadius: "md",
                    m: 2,
                    mb: 3,
                }}
            >
                <Box sx={{display: "flex", gap: 2}}>
                    <IconButton
                        variant="solid"
                        color={isPlaying ? "neutral" : "success"}
                        size="lg"
                        onClick={handleStart}
                        disabled={isPlaying}
                        sx={{boxShadow: "sm"}}
                    >
                        <PowerSettingsNewIcon/>
                    </IconButton>

                    <IconButton
                        variant="solid"
                        color="primary"
                        size="lg"
                        onClick={isPlaying ? handlePause : handlePlay}
                        sx={{boxShadow: "sm"}}
                    >
                        {isPlaying ? <PauseRoundedIcon/> : <PlayArrowRoundedIcon/>}
                    </IconButton>

                    <IconButton
                        variant="solid"
                        color="danger"
                        size="lg"
                        onClick={handleStop}
                        sx={{boxShadow: "sm"}}
                    >
                        <StopRoundedIcon/>
                    </IconButton>
                </Box>

                <Box sx={{display: "flex", alignItems: "center", gap: 1}}>
                    <img
                        src="/4Wall_Logo_Package/fourwall-orange-transparent-cropped.png"
                        alt="4Wall AI Logo"
                        style={{
                            height: "32px",
                            width: "auto",
                            marginRight: "8px",
                        }}
                    />
                    <Typography level="body-lg" sx={{color: "text.secondary"}}>
                        Powered by 4Wall AI
                    </Typography>
                </Box>
            </Sheet>
        </Sheet>
    );
}
