import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Volume2, VolumeX, Loader2 } from "lucide-react";
import { speakText } from "@/services/tts";
import { getTTSConfig } from "@/lib/db";

interface SpeakButtonProps {
  text: string;
  size?: "xs" | "sm" | "default" | "icon-xs" | "icon-sm";
  variant?: "ghost" | "outline";
  className?: string;
}

export function SpeakButton({
  text,
  size = "icon-xs",
  variant = "ghost",
  className,
}: SpeakButtonProps) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();

    if (playing) {
      abortRef.current?.abort();
      abortRef.current = null;
      setPlaying(false);
      return;
    }

    if (loading) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const config = await getTTSConfig();
      if (!config.api_key) return;

      setLoading(false);
      setPlaying(true);
      await speakText(text, config, controller.signal);
    } catch {
      // Abort or error — silently stop
    } finally {
      setLoading(false);
      setPlaying(false);
    }
  }

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={handleClick}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="animate-spin" />
      ) : playing ? (
        <VolumeX />
      ) : (
        <Volume2 />
      )}
    </Button>
  );
}
