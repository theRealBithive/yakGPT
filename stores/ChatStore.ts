import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { Message } from "./Message";
import { streamCompletion } from "./OpenAI";
import { persist } from "zustand/middleware";
import { Chat } from "./Chat";
import { getChatById, updateChatMessages } from "./utils";
import { notifications } from "@mantine/notifications";

type APIState = "idle" | "loading" | "error";

interface SettingsForm {
  model: string;
  temperature: number;
  top_p: number;
  n: number;
  stop: string;
  max_tokens: number;
  presence_penalty: number;
  frequency_penalty: number;
  logit_bias: string;
  // non-model stuff
  push_to_talk_key: string;
}

interface ChatState {
  apiState: APIState;
  apiKey: string | undefined;
  chats: Chat[];
  activeChatId: string | undefined;
  colorScheme: "light" | "dark";
  currentAbortController: AbortController | undefined;
  settingsForm: SettingsForm;
  defaultSettings: SettingsForm;
  navOpened: boolean;
  pushToTalkMode: boolean;
  editingMessage: Message | undefined;

  addChat: (title?: string) => void;
  deleteChat: (id: string) => void;
  setActiveChat: (id: string) => void;
  pushMessage: (message: Message) => void;
  delMessage: (message: Message) => void;
  submitMessage: (message: Message) => void;
  updateMessage: (message: Message) => void;
  setColorScheme: (scheme: "light" | "dark") => void;
  setApiKey: (key: string) => void;
  setApiState: (state: APIState) => void;
  updateSettingsForm: (settings: ChatState["settingsForm"]) => void;
  abortCurrentRequest: () => void;
  setChosenCharacter: (name: string) => void;
  setNavOpened: (opened: boolean) => void;
  setPushToTalkMode: (mode: boolean) => void;
  setEditingMessage: (id: Message | undefined) => void;
  regenerateAssistantMessage: (message: Message) => void;
}

const defaultSettings = {
  model: "gpt-3.5-turbo",
  temperature: 1,
  top_p: 1,
  n: 1,
  stop: "",
  max_tokens: 1024,
  presence_penalty: 0,
  frequency_penalty: 0,
  logit_bias: "",
  // non-model stuff
  push_to_talk_key: "KeyC",
};

const initialChatId = uuidv4();

const initialState = {
  apiState: "idle" as APIState,
  apiKey: process.env.APIKEY || undefined,
  chats: [
    {
      id: initialChatId,
      messages: [],
    },
  ],
  activeChatId: initialChatId,
  colorScheme: "light" as "light" | "dark",
  currentAbortController: undefined,
  settingsForm: defaultSettings,
  defaultSettings: defaultSettings,
  navOpened: false,
  pushToTalkMode: false,
  editingMessage: undefined,
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      ...initialState,
      deleteChat: (id: string) =>
        set((state) => ({
          chats: state.chats.filter((chat) => chat.id !== id),
          activeChatId:
            state.activeChatId === id
              ? state.chats[state.chats.length - 1].id
              : state.activeChatId,
        })),
      addChat: (title?: string) => {
        window.scrollTo(0, 0);
        return set((state) => {
          const id = uuidv4();
          return {
            chats: [
              ...state.chats,
              {
                id,
                title: title,
                messages: [],
              },
            ],
            activeChatId: id,
          };
        });
      },
      setActiveChat: (id: string) => set((state) => ({ activeChatId: id })),
      updateMessage: (message: Message) => {
        const chat = getChatById(get().chats, get().activeChatId);
        if (chat === undefined) {
          console.error("Chat not found");
          return;
        }
        set((state) => ({
          chats: updateChatMessages(state.chats, chat.id, (messages) => {
            return messages.map((m) => (m.id === message.id ? message : m));
          }),
        }));
      },
      pushMessage: async (message: Message) => {
        const chat = getChatById(get().chats, get().activeChatId);
        if (chat === undefined) {
          console.error("Chat not found");
          return;
        }
        set((state) => ({
          chats: updateChatMessages(state.chats, chat.id, (messages) => {
            return [...messages, message];
          }),
        }));
      },
      delMessage: async (message: Message) => {
        const chat = getChatById(get().chats, get().activeChatId);
        if (chat === undefined) {
          console.error("Chat not found");
          return;
        }
        set((state) => ({
          chats: updateChatMessages(state.chats, chat.id, (messages) => {
            return messages.filter((m) => m.id !== message.id);
          }),
        }));
      },
      submitMessage: async (message: Message) => {
        // If message is empty, do nothing
        if (message.content.trim() === "") {
          console.error("Message is empty");
          return;
        }
        const chat = get().chats.find((c) => c.id === get().activeChatId);
        if (chat === undefined) {
          console.error("Chat not found");
          return;
        }

        // If this is an existing message, remove all the messages after it
        const index = chat.messages.findIndex((m) => m.id === message.id);
        if (index !== -1) {
          set((state) => ({
            chats: state.chats.map((c) => {
              if (c.id === chat.id) {
                c.messages = c.messages.slice(0, index);
              }
              return c;
            }),
          }));
        }

        // Add the message
        set((state) => ({
          apiState: "loading",
          chats: state.chats.map((c) => {
            if (c.id === chat.id) {
              c.messages.push(message);
            }
            return c;
          }),
        }));

        const assistantMsgId = uuidv4();
        // Add the assistant's response
        set((state) => ({
          chats: state.chats.map((c) => {
            if (c.id === chat.id) {
              c.messages.push({
                id: assistantMsgId,
                content: "",
                role: "assistant",
                loading: true,
              });
            }
            return c;
          }),
        }));

        const apiKey = get().apiKey;
        if (apiKey === undefined) {
          console.error("API key not set");
          return;
        }

        const updateTokens = (tokensUsed: number) => {
          set((state) => ({
            apiState: "idle",
            chats: state.chats.map((c) => {
              if (c.id === chat.id) {
                c.tokensUsed = tokensUsed;
              }
              return c;
            }),
          }));
        };
        const settings = get().settingsForm;

        const abortController = new AbortController();
        set((state) => ({ currentAbortController: abortController }));

        // ASSISTANT REQUEST
        await streamCompletion(
          chat.messages,
          settings,
          apiKey,
          abortController,
          (content) => {
            set((state) => ({
              chats: updateChatMessages(state.chats, chat.id, (messages) => {
                const assistantMessage = messages.find(
                  (m) => m.id === assistantMsgId
                );
                if (assistantMessage) {
                  assistantMessage.content += content;
                }
                return messages;
              }),
            }));
          },
          (tokensUsed) => {
            set((state) => ({
              apiState: "idle",
              chats: updateChatMessages(state.chats, chat.id, (messages) => {
                const assistantMessage = messages.find(
                  (m) => m.id === assistantMsgId
                );
                if (assistantMessage) {
                  assistantMessage.loading = false;
                }
                return messages;
              }),
            }));
            updateTokens(tokensUsed);
            findChatTitle();
          },
          (errorRes, errorBody) => {
            let message = errorBody;
            try {
              message = JSON.parse(errorBody).error.message;
            } catch (e) {}

            notifications.show({
              message: message,
              color: "red",
            });
          }
        );

        const findChatTitle = async () => {
          const chat = getChatById(get().chats, get().activeChatId);
          if (chat === undefined) {
            console.error("Chat not found");
            return;
          }
          // Find a good title for the chat
          const numWords = chat.messages
            .map((m) => m.content.split(" ").length)
            .reduce((a, b) => a + b, 0);
          if (
            chat.messages.length >= 2 &&
            chat.title === undefined &&
            numWords >= 4
          ) {
            const msg = {
              id: uuidv4(),
              content: `Describe the following conversation snippet in 3 words or less.
            >>>
            Hello
            ${chat.messages
              .slice(1)
              .map((m) => m.content)
              .join("\n")}
            >>>
              `,
              role: "system",
            } as Message;

            await streamCompletion(
              [msg, ...chat.messages.slice(1)],
              settings,
              apiKey,
              undefined,
              (content) => {
                set((state) => ({
                  chats: state.chats.map((c) => {
                    if (c.id === chat.id) {
                      // Find message with id
                      chat.title = (chat.title || "") + content;
                      if (chat.title.toLowerCase().startsWith("title:")) {
                        chat.title = chat.title.slice(6).trim();
                      }
                      // Remove trailing punctuation
                      chat.title = chat.title.replace(/[,.;:!?]$/, "");
                    }
                    return c;
                  }),
                }));
              },
              updateTokens
            );
          }
        };
      },
      setColorScheme: (scheme: "light" | "dark") =>
        set((state) => ({ colorScheme: scheme })),
      setApiKey: (key: string) => set((state) => ({ apiKey: key })),
      setApiState: (apiState: APIState) => set((state) => ({ apiState })),
      updateSettingsForm: (settingsForm: ChatState["settingsForm"]) =>
        set((state) => ({ settingsForm })),
      abortCurrentRequest: () => {
        const currentAbortController = get().currentAbortController;
        console.log("aborting current request", currentAbortController);
        if (currentAbortController?.abort) currentAbortController?.abort();
        set((state) => ({
          apiState: "idle",
          currentAbortController: undefined,
        }));
      },
      setChosenCharacter: (name: string) =>
        set((state) => ({
          chats: state.chats.map((c) => {
            if (c.id === state.activeChatId) {
              c.chosenCharacter = name;
            }
            return c;
          }),
        })),
      setNavOpened: (navOpened: boolean) => set((state) => ({ navOpened })),
      setPushToTalkMode: (pushToTalkMode: boolean) =>
        set((state) => ({ pushToTalkMode })),
      setEditingMessage: (editingMessage: Message | undefined) =>
        set((state) => ({ editingMessage })),
      regenerateAssistantMessage: (message: Message) => {
        const chat = getChatById(get().chats, get().activeChatId);
        if (chat === undefined) {
          console.error("Chat not found");
          return;
        }

        // If this is an existing message, remove all the messages after it
        const index = chat.messages.findIndex((m) => m.id === message.id);

        const prevMsg = chat.messages[index - 1];
        if (prevMsg) {
          get().submitMessage(prevMsg);
        }
      },
    }),
    {
      name: "chat-store-v23",
      partialize: (state) => state,
    }
  )
);
