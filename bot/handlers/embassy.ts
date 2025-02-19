import config from "config";
import { Message } from "node-telegram-bot-api";
import { PingResponse } from "ping";
import { dir } from "tmp-promise";

import fetch from "node-fetch";

import { BotConfig, EmbassyApiConfig } from "@config";
import usersRepository from "@repositories/users";
import fundsRepository from "@repositories/funds";
import broadcast, { BroadcastEvents } from "@services/broadcast";
import { requestToEmbassy } from "@services/embassy";
import { getDonationsSummary } from "@services/export";
import { AvailableConditioner, ConditionerActions, ConditionerMode, ConditionerStatus, SpaceClimate } from "@services/hass";
import logger from "@services/logger";
import { PrinterStatusResult } from "@services/printer3d";
import { filterPeopleInside, hasDeviceInside, UserStateService } from "@services/status";
import { sleep } from "@utils/common";
import { readFileAsBase64 } from "@utils/filesystem";
import { filterFulfilled } from "@utils/filters";
import { UnlockMethod } from "@services/door";
import { AvailableModels, openAI } from "@services/neural";

import HackerEmbassyBot, { PUBLIC_CHATS } from "../core/HackerEmbassyBot";
import { ButtonFlags, InlineButton } from "../core/InlineButtons";
import t from "../core/localization";
import { BotCustomEvent, BotHandlers, BotMessageContextMode } from "../core/types";
import * as helpers from "../core/helpers";
import * as TextGenerators from "../textGenerators";
import { effectiveName, hasRole } from "../core/helpers";

const embassyApiConfig = config.get<EmbassyApiConfig>("embassy-api");
const botConfig = config.get<BotConfig>("bot");

enum DeviceOperation {
    Help = "help",
    Status = "status",
    Up = "up",
    Down = "down",
}

type SdToImageRequest = {
    prompt: string;
    negative_prompt?: string;
    image?: string;
};

export default class EmbassyHandlers implements BotHandlers {
    static async unlockHandler(bot: HackerEmbassyBot, msg: Message) {
        const user = bot.context(msg).user;

        try {
            const hasMacInside = await hasDeviceInside(user);

            if (!hasMacInside) return bot.sendMessageExt(msg.chat.id, t("embassy.unlock.nomac"), msg);

            const response = await requestToEmbassy(
                `/space/unlock`,
                "POST",
                { from: user.username ?? user.userid, method: UnlockMethod.HTTP },
                20000,
                true
            );

            if (!response.ok)
                throw Error("Unlock request to space failed", {
                    cause: response.statusText,
                });

            broadcast.emit(BroadcastEvents.SpaceUnlocked, user.username);
            logger.info(`${user.username}[${user.userid}] opened the door`);

            return bot.sendMessageExt(msg.chat.id, t("embassy.unlock.success"), msg);
        } catch (error) {
            logger.error(error);

            return bot.sendMessageExt(msg.chat.id, t("embassy.common.fail"), msg);
        }
    }

    static async unlockedNotificationHandler(bot: HackerEmbassyBot, username: string) {
        try {
            await bot.sendMessageExt(
                botConfig.chats.alerts,
                t("embassy.unlock.success-alert", { user: helpers.formatUsername(username) }),
                null
            );
        } catch (error) {
            logger.error(error);
        }
    }

    static async allCamsHandler(bot: HackerEmbassyBot, msg: Message) {
        bot.sendChatAction(msg.chat.id, "upload_photo", msg);

        try {
            const camNames = Object.keys(embassyApiConfig.cams);
            const camResponses = await Promise.allSettled(camNames.map(name => requestToEmbassy(`/cameras/${name}`)));

            const images: ArrayBuffer[] = await Promise.all(
                filterFulfilled(camResponses)
                    .filter(result => result.value.ok)
                    .map(result => result.value.arrayBuffer())
            );

            if (images.length > 0) await bot.sendPhotos(msg.chat.id, images, msg);
            else throw Error("No available images");
        } catch (error) {
            logger.error(error);

            await bot.sendMessageExt(msg.chat.id, t("embassy.webcam.failall"), msg);
        }
    }

    static async getWebcamImage(camName: string) {
        const response = await (await requestToEmbassy(`/cameras/${camName}`)).arrayBuffer();

        return Buffer.from(response);
    }

    static async liveWebcamHandler(bot: HackerEmbassyBot, msg: Message, camName: string, mode: BotMessageContextMode) {
        await sleep(1000); // Delay to prevent sending too many requests at once. TODO rework

        try {
            const webcamImage = await EmbassyHandlers.getWebcamImage(camName);

            const inline_keyboard = mode.static
                ? []
                : [[InlineButton(t("status.buttons.refresh"), `webcam`, ButtonFlags.Editing, { params: camName })]];

            await bot.editPhoto(webcamImage, msg, {
                reply_markup: {
                    inline_keyboard,
                },
            });
        } catch {
            // Skip this update
        }
    }

    static async webcamHandler(bot: HackerEmbassyBot, msg: Message, camName: string) {
        bot.sendChatAction(msg.chat.id, "upload_photo", msg);

        try {
            const context = bot.context(msg);
            const mode = context.mode;

            const webcamImage = await EmbassyHandlers.getWebcamImage(camName);

            const inline_keyboard = [
                [
                    InlineButton(t("status.buttons.refresh"), "webcam", ButtonFlags.Editing, { params: camName }),
                    InlineButton(t("status.buttons.save"), "removebuttons"),
                ],
            ];

            if (webcamImage.byteLength === 0) throw Error("Empty webcam image");

            if (context.isEditing) {
                await bot.editPhoto(webcamImage, msg, {
                    reply_markup: {
                        inline_keyboard,
                    },
                });

                return;
            }

            const resultMessage = await bot.sendPhotoExt(msg.chat.id, webcamImage, msg, {
                reply_markup: {
                    inline_keyboard,
                },
            });

            if (mode.live) {
                bot.addLiveMessage(
                    resultMessage,
                    BotCustomEvent.camLive,
                    () => EmbassyHandlers.liveWebcamHandler(bot, resultMessage, camName, mode),
                    {
                        functionName: EmbassyHandlers.liveWebcamHandler.name,
                        module: __filename,
                        params: [resultMessage, camName, mode],
                    }
                );
            }
        } catch (error) {
            logger.error(error);
            const camLocationName = t(`embassy.webcam.location.${camName}`);

            await bot.sendMessageExt(msg.chat.id, t("embassy.webcam.fail", { camLocationName }), msg);
        }
    }

    static async printersHandler(bot: HackerEmbassyBot, msg: Message) {
        const text = TextGenerators.getPrintersInfo();
        const inline_keyboard = [
            [
                InlineButton(t("embassy.printers.anettestatus"), "printerstatus", ButtonFlags.Simple, { params: "anette" }),
                InlineButton(t("embassy.printers.plumbusstatus"), "printerstatus", ButtonFlags.Simple, { params: "plumbus" }),
            ],
            [InlineButton(t("general.buttons.menu"), "startpanel", ButtonFlags.Editing)],
        ];

        await bot.sendOrEditMessage(
            msg.chat.id,
            text,
            msg,
            {
                reply_markup: {
                    inline_keyboard,
                },
            },
            msg.message_id
        );
    }

    static async climateHandler(bot: HackerEmbassyBot, msg: Message) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        let message = t("embassy.climate.nodata");

        try {
            const climateResponse = await requestToEmbassy(`/climate`);

            if (!climateResponse.ok) throw Error();

            const climateInfo = (await climateResponse.json()) as SpaceClimate;
            message = t("embassy.climate.data", { climateInfo });

            if (msg.chat.id === botConfig.chats.horny) {
                message += t("embassy.climate.secretdata", { climateInfo });
            }
        } catch (error) {
            logger.error(error);
        }

        return await bot.sendMessageExt(msg.chat.id, message, msg);
    }

    static async printerStatusHandler(bot: HackerEmbassyBot, msg: Message, printername: string) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            const response = await requestToEmbassy(`/printers/${printername}`);

            if (!response.ok) throw Error();

            const { status, thumbnailBuffer, cam } = (await response.json()) as PrinterStatusResult;

            if (cam) await bot.sendPhotoExt(msg.chat.id, Buffer.from(cam), msg);

            const caption = TextGenerators.getPrinterStatusText(status);
            const inline_keyboard = [
                [
                    InlineButton(t("embassy.printerstatus.update", { printername }), "printerstatus", ButtonFlags.Editing, {
                        params: printername,
                    }),
                ],
            ];

            if (thumbnailBuffer) {
                await bot.sendOrEditPhoto(msg.chat.id, Buffer.from(thumbnailBuffer), msg, {
                    caption: caption,
                    reply_markup: { inline_keyboard },
                });
            } else await bot.sendOrEditMessage(msg.chat.id, caption, msg, { reply_markup: { inline_keyboard } }, msg.message_id);
        } catch (error) {
            logger.error(error);
            if (!bot.context(msg).isEditing) await bot.sendMessageExt(msg.chat.id, t("embassy.printerstatus.fail"), msg);
        }
    }

    static async doorbellHandler(bot: HackerEmbassyBot, msg: Message) {
        try {
            const response = await requestToEmbassy(`/space/doorbell`);

            if (!response.ok) throw Error();

            await bot.sendMessageExt(msg.chat.id, t("embassy.doorbell.success"), msg);
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("embassy.doorbell.fail"), msg);
        }
    }

    static async wakeHandler(bot: HackerEmbassyBot, msg: Message, deviceName: string) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            const response = await requestToEmbassy(`/devices/${deviceName}/wake`, "POST");

            if (!response.ok) throw Error();

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.wake.success"), msg);
        } catch (error) {
            logger.error(error);

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.wake.fail"), msg);
        }
    }

    static async deviceHandler(
        bot: HackerEmbassyBot,
        msg: Message,
        deviceName: string,
        operation: DeviceOperation = DeviceOperation.Help
    ) {
        try {
            const device = embassyApiConfig.devices[deviceName];

            if (!device) throw Error();

            switch (operation) {
                case DeviceOperation.Up:
                    return EmbassyHandlers.wakeHandler(bot, msg, deviceName);
                case DeviceOperation.Down:
                    return EmbassyHandlers.shutdownHandler(bot, msg, deviceName);
                case DeviceOperation.Status:
                    return EmbassyHandlers.pingHandler(bot, msg, deviceName, false);
                default:
                    break;
            }

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.help", { deviceName }), msg);
        } catch (error) {
            logger.error(error);

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.notfound"), msg);
        }
    }

    static async shutdownHandler(bot: HackerEmbassyBot, msg: Message, deviceName: string) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            const response = await requestToEmbassy(`/devices/${deviceName}/shutdown`, "POST");

            if (!response.ok) throw Error();

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.shutdown.success"), msg);
        } catch (error) {
            logger.error(error);

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.shutdown.fail"), msg);
        }
    }

    static async pingHandler(bot: HackerEmbassyBot, msg: Message, deviceName: string, raw: boolean = false) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            const response = await requestToEmbassy(`/devices/${deviceName}/ping`, "POST");

            if (!response.ok) throw Error();

            const body = (await response.json()) as PingResponse;

            await bot.sendMessageExt(
                msg.chat.id,
                raw
                    ? body.output
                    : body.alive
                      ? t("embassy.device.alive.up", { time: body.time })
                      : t("embassy.device.alive.down"),
                msg
            );
        } catch (error) {
            logger.error(error);

            await bot.sendMessageExt(msg.chat.id, t("embassy.device.alive.fail"), msg);
        }
    }

    static async heyHandler(bot: HackerEmbassyBot, msg: Message) {
        if (!PUBLIC_CHATS.includes(msg.chat.id)) {
            await bot.sendMessageExt(msg.chat.id, t("general.chatnotallowed"), msg);
            return;
        }

        const residents = usersRepository.getUsersByRole("member");
        const residentsInside = UserStateService.getRecentUserStates()
            .filter(filterPeopleInside)
            .filter(insider => residents.find(r => r.username === insider.user.username));

        const text =
            residentsInside.length > 0
                ? t("embassy.hey.text", {
                      residentsInside: residentsInside.reduce((acc, resident) => acc + `@${resident.user.username} `, ""),
                  })
                : t("embassy.hey.noresidents");
        await bot.sendMessageExt(msg.chat.id, text, msg);

        if (residentsInside.length > 0) {
            bot.context(msg).mode.silent = true;

            await EmbassyHandlers.sayinspaceHandler(
                bot,
                msg,
                `Эй, резиденты, вас зовет ${effectiveName(bot.context(msg).user)}. Ответьте пожожда в чатике.`
            );
        }
    }

    static async sayinspaceHandler(bot: HackerEmbassyBot, msg: Message, text: string) {
        bot.sendChatAction(msg.chat.id, "upload_voice", msg);

        try {
            if (!text) {
                bot.sendMessageExt(msg.chat.id, t("embassy.say.help"), msg);
                return;
            }

            const response = await requestToEmbassy(`/speaker/tts`, "POST", { text }, 30000);

            if (response.ok) await bot.sendMessageExt(msg.chat.id, t("embassy.say.success"), msg);
            else throw Error("Failed to say in space");
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("embassy.say.fail"), msg);
        }
    }

    static async textinspaceHandler(bot: HackerEmbassyBot, msg: Message, text?: string) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            if (!text || text.length === 0) {
                bot.sendMessageExt(msg.chat.id, t("embassy.text.help"), msg);
                return;
            }

            const response = await requestToEmbassy(`/space/led-matrix`, "POST", { message: text }, 30000);

            if (response.ok) await bot.sendMessageExt(msg.chat.id, t("embassy.text.success"), msg);
            else throw Error("Failed to send a message to the led matrix");
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("embassy.text.fail"), msg);
        }
    }

    static async htmlinspaceHandler(bot: HackerEmbassyBot, msg: Message, html?: string) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            if (!html || html.length === 0) {
                bot.sendMessageExt(msg.chat.id, t("embassy.html.help"), msg);
                return;
            }

            const response =
                html === "remove" || html === "clear"
                    ? await requestToEmbassy(`/screen/close_popup`, "POST")
                    : await requestToEmbassy(`/screen/popup`, "POST", { html }, 30000);

            if (response.ok) await bot.sendMessageExt(msg.chat.id, t("embassy.html.success"), msg);
            else throw Error("Failed to send a message to the led matrix");
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("embassy.html.fail"), msg);
        }
    }

    static async sendDonationsSummaryHandler(bot: HackerEmbassyBot, msg: Message, fund?: string) {
        try {
            const selectedFund = fund ? fundsRepository.getFundByName(fund) : fundsRepository.getLatestCosts();

            if (!selectedFund) throw Error(`No fund ${fund} found`);

            const donationsSummary = await getDonationsSummary(selectedFund);

            await EmbassyHandlers.textinspaceHandler(
                bot,
                msg,
                `${donationsSummary.strings.fund_stats}    ${donationsSummary.strings.ranked_donations}`
            );
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("funds.export.fail"), msg);
        }
    }

    static async stopMediaHandler(bot: HackerEmbassyBot, msg: Message, silentMessage: boolean = false) {
        bot.sendChatAction(msg.chat.id, "upload_document", msg);

        try {
            const response = await requestToEmbassy(`/speaker/stop`, "POST");

            if (response.ok) !silentMessage && (await bot.sendMessageExt(msg.chat.id, t("embassy.stop.success"), msg));
            else throw Error("Failed to stop media in space");
        } catch (error) {
            logger.error(error);
            !silentMessage && (await bot.sendMessageExt(msg.chat.id, t("embassy.stop.fail"), msg));
        }
    }

    static async availableSoundsHandler(bot: HackerEmbassyBot, msg: Message) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            const response = await requestToEmbassy(`/speaker/sounds`);

            if (response.ok) {
                const { sounds } = (await response.json()) as { sounds: string[] };
                const soundsText = sounds.map(s => `#\`/play ${s}#\``).join("\n");

                await bot.sendMessageExt(msg.chat.id, t("embassy.availablesounds.success", { sounds: soundsText }), msg);
            } else throw Error("Failed to fetch available sounds");
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("embassy.availablesounds.fail"), msg);
        }
    }

    static async voiceInSpaceHandler(bot: HackerEmbassyBot, msg: Message) {
        const context = bot.context(msg);
        const isMember = context.user.roles?.includes("member");
        const voiceFileId = msg.voice?.file_id;

        if (!context.isPrivate() || !voiceFileId || !isMember) return;

        const link = await bot.getFileLink(voiceFileId);

        await EmbassyHandlers.playinspaceHandler(bot, msg, link);
    }

    static async playinspaceHandler(bot: HackerEmbassyBot, msg: Message, linkOrName: string, silentMessage: boolean = false) {
        bot.sendChatAction(msg.chat.id, "upload_document", msg);

        try {
            if (!linkOrName) {
                bot.sendMessageExt(msg.chat.id, t("embassy.play.help"), msg);
                return;
            }

            // TODO move to hass
            const defaultMediaBase = "http://le-fail.lan:8001";
            const link = linkOrName.startsWith("http") ? linkOrName : `${defaultMediaBase}/${linkOrName}.mp3`;

            const response = await requestToEmbassy(`/speaker/play`, "POST", { link });

            if (response.ok) !silentMessage && (await bot.sendMessageExt(msg.chat.id, t("embassy.play.success"), msg));
            else throw Error("Failed to play in space");
        } catch (error) {
            logger.error(error);
            !silentMessage && (await bot.sendMessageExt(msg.chat.id, t("embassy.play.fail"), msg));
        }
    }

    static async conditionerHandler(bot: HackerEmbassyBot, msg: Message, name: AvailableConditioner) {
        if (!bot.context(msg).isEditing) bot.sendChatAction(msg.chat.id, "typing", msg);

        let text = t("embassy.conditioner.unavailable");
        const buttonFlags = ButtonFlags.Silent | ButtonFlags.Editing;

        const inline_keyboard = [
            [
                InlineButton(t("embassy.conditioner.buttons.turnon"), "acon", buttonFlags, {
                    params: name,
                }),
                InlineButton(t("embassy.conditioner.buttons.turnoff"), "acoff", buttonFlags, {
                    params: name,
                }),
                InlineButton(t("embassy.conditioner.buttons.preheat"), "preheat", buttonFlags, {
                    params: name,
                }),
            ],
            [
                InlineButton(t("embassy.conditioner.buttons.more"), `acaddtemp`, buttonFlags, {
                    params: [name, 1],
                }),
                InlineButton(t("embassy.conditioner.buttons.less"), `acaddtemp`, buttonFlags, {
                    params: [name, -1],
                }),
            ],
            [
                InlineButton(t("embassy.conditioner.buttons.auto"), `acmode`, buttonFlags, {
                    params: [name, "heat_cool"],
                }),
                InlineButton(t("embassy.conditioner.buttons.heat"), `acmode`, buttonFlags, {
                    params: [name, "heat"],
                }),
                InlineButton(t("embassy.conditioner.buttons.cool"), `acmode`, buttonFlags, {
                    params: [name, "cool"],
                }),
                InlineButton(t("embassy.conditioner.buttons.dry"), `acmode`, buttonFlags, {
                    params: [name, "dry"],
                }),
            ],
            [
                InlineButton(t("status.buttons.refresh"), "conditioner", ButtonFlags.Editing, { params: name }),
                InlineButton(t("basic.control.buttons.back"), "controlpanel", ButtonFlags.Editing),
            ],
        ];

        try {
            const response = await requestToEmbassy(`/climate/conditioners/${name}/${ConditionerActions.STATE}`);

            if (!response.ok) throw Error();

            const conditionerStatus = (await response.json()) as ConditionerStatus;

            text = t("embassy.conditioner.status", { name, conditionerStatus, firm: name === "downstairs" ? "midea" : "lg" });
        } catch (error) {
            logger.error(error);
        } finally {
            await bot.sendOrEditMessage(
                msg.chat.id,
                text,
                msg,
                {
                    reply_markup: {
                        inline_keyboard,
                    },
                },
                msg.message_id
            );
        }
    }

    static async turnOnConditionerHandler(bot: HackerEmbassyBot, msg: Message, name: AvailableConditioner) {
        await EmbassyHandlers.controlConditioner(bot, msg, name, ConditionerActions.POWER_ON, null);

        if (bot.context(msg).isButtonResponse) await EmbassyHandlers.conditionerHandler(bot, msg, name);
    }

    static async turnOffConditionerHandler(bot: HackerEmbassyBot, msg: Message, name: AvailableConditioner) {
        await EmbassyHandlers.controlConditioner(bot, msg, name, ConditionerActions.POWER_OFF, null);

        if (bot.context(msg).isButtonResponse) await EmbassyHandlers.conditionerHandler(bot, msg, name);
    }

    static async addConditionerTempHandler(bot: HackerEmbassyBot, msg: Message, name: AvailableConditioner, diff: number) {
        if (isNaN(diff)) throw Error();
        await EmbassyHandlers.controlConditioner(bot, msg, name, ConditionerActions.TEMPERATURE, { diff });

        if (bot.context(msg).isButtonResponse) {
            await sleep(5000); // Updating the temperature is slow on Midea
            await EmbassyHandlers.conditionerHandler(bot, msg, name);
        }
    }

    static async setConditionerTempHandler(bot: HackerEmbassyBot, msg: Message, name: AvailableConditioner, temperature: number) {
        if (isNaN(temperature)) throw Error();
        await EmbassyHandlers.controlConditioner(bot, msg, name, ConditionerActions.TEMPERATURE, { temperature });
    }

    static async setConditionerModeHandler(
        bot: HackerEmbassyBot,
        msg: Message,
        name: AvailableConditioner,
        mode: ConditionerMode
    ) {
        await EmbassyHandlers.controlConditioner(bot, msg, name, ConditionerActions.MODE, { mode });

        if (bot.context(msg).isButtonResponse) await EmbassyHandlers.conditionerHandler(bot, msg, name);
    }

    static async preheatHandler(bot: HackerEmbassyBot, msg: Message, name: AvailableConditioner) {
        await EmbassyHandlers.controlConditioner(bot, msg, name, ConditionerActions.PREHEAT, {});

        if (bot.context(msg).isButtonResponse) await EmbassyHandlers.conditionerHandler(bot, msg, name);
    }

    static async controlConditioner(
        bot: HackerEmbassyBot,
        msg: Message,
        name: AvailableConditioner,
        action: ConditionerActions,
        body: any
    ) {
        bot.sendChatAction(msg.chat.id, "typing", msg);

        try {
            const response = await requestToEmbassy(`/climate/conditioners/${name}/${action}`, "POST", body);

            if (!response.ok) throw Error();

            await bot.sendMessageExt(msg.chat.id, t("embassy.conditioner.success"), msg);
        } catch (error) {
            logger.error(error);

            await bot.sendMessageExt(msg.chat.id, t("embassy.conditioner.fail"), msg);
        }
    }

    static async stableDiffusiondHandler(bot: HackerEmbassyBot, msg: Message, prompt: string) {
        const photoId = msg.photo?.[0]?.file_id;

        try {
            // Guards
            if (msg.chat.id !== botConfig.chats.horny && !hasRole(bot.context(msg).user, "trusted", "member"))
                return bot.sendRestrictedMessage(msg);
            if (!PUBLIC_CHATS.includes(msg.chat.id)) return bot.sendMessageExt(msg.chat.id, t("general.chatnotallowed"), msg);
            if (!prompt && !photoId) return bot.sendMessageExt(msg.chat.id, t("embassy.neural.sd.help"), msg);

            bot.sendChatAction(msg.chat.id, "upload_document", msg);
            const [positive_prompt, negative_prompt] = prompt ? prompt.split("!=", 2).map(pr => pr.trim()) : ["", ""];
            const requestBody = { prompt: positive_prompt, negative_prompt } as SdToImageRequest;

            if (photoId) {
                const { path, cleanup } = await dir({
                    unsafeCleanup: true,
                });
                const photoPath = await bot.downloadFile(photoId, path);
                requestBody.image = await readFileAsBase64(photoPath);
                cleanup();
            }

            const response = await requestToEmbassy(photoId ? "/neural/sd/img2img" : "/neural/sd/txt2img", "POST", requestBody);

            if (response.ok) {
                const body = (await response.json()) as { image: string };
                const imageBuffer = Buffer.from(body.image, "base64");

                await bot.sendPhotoExt(msg.chat.id, imageBuffer, msg);
            } else throw Error("Failed to generate an image");
        } catch (error) {
            logger.error(error);
            await bot.sendMessageExt(msg.chat.id, t("embassy.neural.sd.fail"), msg);
        }
    }

    static async askHandler(bot: HackerEmbassyBot, msg: Message, prompt: string, model: AvailableModels = AvailableModels.GPT) {
        const loading = setInterval(() => bot.sendChatAction(msg.chat.id, "typing", msg), 5000);

        try {
            // Guards
            if (msg.chat.id !== botConfig.chats.horny && !hasRole(bot.context(msg).user, "trusted", "member"))
                return bot.sendRestrictedMessage(msg);
            if (!PUBLIC_CHATS.includes(msg.chat.id)) return bot.sendMessageExt(msg.chat.id, t("general.chatnotallowed"), msg);
            if (!prompt) return bot.sendMessageExt(msg.chat.id, t("service.openai.help"), msg);

            bot.sendChatAction(msg.chat.id, "typing", msg);
            const loading = setTimeout(() => bot.sendChatAction(msg.chat.id, "typing", msg), 5000);

            const response =
                model === AvailableModels.GPT
                    ? await openAI.askChat(prompt)
                    : await requestToEmbassy("/neural/ollama/generate", "POST", { prompt }, 90000)
                          .then(response => response.json())
                          .then(data => (data as { response: string }).response);

            clearInterval(loading);

            await bot.sendMessageExt(msg.chat.id, response, msg);
        } catch (error) {
            await bot.sendMessageExt(msg.chat.id, t("service.openai.error"), msg);
            logger.error(error);
        } finally {
            clearInterval(loading);
        }
    }

    static async checkOutageMentionsHandler(bot: HackerEmbassyBot, msg?: Message) {
        const EMBASSY_STREET = t("embassy.ena.street");
        const EMBASSY_STREET_HY = "Պուշկինի";
        const ENA_OUTAGES_URL_HY = "https://www.ena.am/Info.aspx?id=5&lang=1";
        const destinationChat = msg?.chat.id ?? botConfig.chats.alerts;

        try {
            const enaPageContent = await fetch(ENA_OUTAGES_URL_HY).then(res => res.text());
            const isElectricityOutage = enaPageContent.toLowerCase().includes(EMBASSY_STREET_HY.toLowerCase());
            const needToRespond = msg || bot.botState.flags.electricityOutageMentioned !== isElectricityOutage;

            if (!needToRespond) return;

            if (!msg) {
                bot.botState.flags.electricityOutageMentioned = isElectricityOutage;
                await bot.botState.persistChanges();
            }

            await bot.sendMessageExt(
                destinationChat,
                t(isElectricityOutage ? "embassy.ena.mentioned" : "embassy.ena.notmentioned", {
                    hystreet: EMBASSY_STREET_HY,
                    street: EMBASSY_STREET,
                }),
                msg ?? null
            );
        } catch (error) {
            logger.error(error);
            if (msg) await bot.sendMessageExt(msg.chat.id, t("embassy.ena.fail"), msg);
        }
    }
}
