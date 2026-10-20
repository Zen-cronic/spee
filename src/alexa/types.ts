// The parts of the Alexa custom-skill request and response envelopes this skill reads and writes
// (https://developer.amazon.com/docs/custom-skills/request-and-response-json-reference.html).
export interface AlexaSlot {
  name: string;
  value?: string;
  confirmationStatus?: string;
}
export interface AlexaIntentPayload {
  name: string;
  confirmationStatus?: string;
  slots?: Record<string, AlexaSlot>;
}
export type SessionAttributes = Record<string, unknown> & { attemptId?: string; cardId?: string; drillSessionId?: string }; // drillSessionId: the hub session this skill session started
export interface AlexaRequestEnvelope {
  version: string;
  session?: {
    new?: boolean;
    sessionId?: string;
    application?: { applicationId?: string };
    attributes?: SessionAttributes;
    user?: { userId?: string };
  };
  context?: {
    System?: {
      application?: { applicationId?: string };
      apiEndpoint?: string;
      apiAccessToken?: string;
      user?: { userId?: string };
      // "Alexa.Presentation.APL" is listed only by a device with a screen (src/alexa/apl.ts)
      device?: { deviceId?: string; supportedInterfaces?: Record<string, unknown> };
    };
    // Screen devices describe their display (src/alexa/device.ts logs it once per kind of device)
    Viewport?: { mode?: string; shape?: string; pixelWidth?: number; pixelHeight?: number; dpi?: number };
  };
  request: {
    type: "LaunchRequest" | "IntentRequest" | "SessionEndedRequest" | string;
    requestId?: string;
    timestamp?: string;
    locale?: string;
    intent?: AlexaIntentPayload;
    reason?: string;
    error?: { type?: string; message?: string };
  };
}
export interface OutputSpeech {
  type: "PlainText" | "SSML";
  text?: string;
  ssml?: string;
}
export interface AlexaDirective {
  type: string;
  token?: string;
  document?: Record<string, unknown>;
  datasources?: Record<string, unknown>;
}
export interface AlexaResponseEnvelope {
  version: "1.0";
  sessionAttributes?: SessionAttributes;
  response: {
    outputSpeech?: OutputSpeech;
    reprompt?: { outputSpeech: OutputSpeech };
    shouldEndSession?: boolean;
    directives?: AlexaDirective[];
  };
}
