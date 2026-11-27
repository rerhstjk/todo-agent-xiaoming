import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechResult {
  text: string;
  /** 浏览器确认后的最终结果；false 是边说边变的中间结果。 */
  final: boolean;
}

function recognitionConstructor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

function speechErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "浏览器没有麦克风权限，请在地址栏授予权限后再试，或者直接打字。";
    case "no-speech":
      return "没有听到声音，点一下麦克风再说一次。";
    case "audio-capture":
      return "没有找到可用的麦克风，请检查系统设置。";
    case "network":
      return "语音识别需要联网，网络不可用时可以直接打字。";
    case "aborted":
      return "";
    default:
      return "语音识别出错了，再试一次或者直接打字。";
  }
}

/**
 * 语音转文字：只在浏览器支持时可用，不支持的浏览器由调用方隐藏入口。
 * 识别结果通过 onResult 逐段给出，中间结果会被最终结果替换。
 */
export function useSpeechInput(
  onResult: (result: SpeechResult) => void,
  onError?: (message: string) => void,
) {
  const supported = useRef(recognitionConstructor() !== undefined).current;
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const resultHandler = useRef(onResult);
  const errorHandler = useRef(onError);

  useEffect(() => {
    resultHandler.current = onResult;
    errorHandler.current = onError;
  }, [onError, onResult]);

  const stop = useCallback(() => {
    recognition.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Constructor = recognitionConstructor();
    if (!Constructor) return;
    recognition.current?.abort();

    const instance = new Constructor();
    instance.lang = "zh-CN";
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.onstart = () => setListening(true);
    instance.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (text) resultHandler.current({ text, final: result.isFinal });
      }
    };
    instance.onerror = (event) => {
      setListening(false);
      const message = speechErrorMessage(event.error);
      if (message) errorHandler.current?.(message);
    };
    instance.onend = () => setListening(false);
    recognition.current = instance;
    try {
      instance.start();
    } catch {
      setListening(false);
      errorHandler.current?.("语音输入启动失败，请直接打字。");
    }
  }, []);

  useEffect(() => () => recognition.current?.abort(), []);

  return { supported, listening, start, stop };
}
