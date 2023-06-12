const { fetchWithTimeout } = require("../../utils/network");
const logger = require("../../services/logger");
const { encrypt } = require("../../utils/security");
const { isMacInside } = require("../../services/statusHelper");

const config = require("config");
const embassyApiConfig = config.get("embassy-api");
const botConfig = config.get("bot");

const TextGenerators = require("../../services/textGenerators");
const UsersHelper = require("../../services/usersHelper");
const usersRepository = require("../../repositories/usersRepository");

class EmbassyHanlers {
    static unlockHandler = async (bot, msg) => {
        if (!UsersHelper.hasRole(msg.from.username, "admin", "member")) return;

        try {
            let devices = await (
                await fetchWithTimeout(
                    `${embassyApiConfig.host}:${embassyApiConfig.port}/${embassyApiConfig.devicesCheckingPath}`
                )
            )?.json();

            let currentUser = usersRepository.getUserByName(msg.from.username);

            if (!isMacInside(currentUser.mac, devices)) {
                bot.sendMessage(
                    msg.chat.id,
                    "❌ Твой MAC адрес не обнаружен роутером. Надо быть рядом со спейсом, чтобы его открыть"
                );

                return;
            }

            let token = await encrypt(process.env["UNLOCKKEY"]);

            let response = await await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/unlock`, {
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                method: "post",
                body: JSON.stringify({ token, from: msg.from.username }),
            });

            if (response.status === 200) {
                logger.info(`${msg.from.username} открыл дверь`);
                await bot.sendMessage(msg.chat.id, "🔑 Дверь открыта");
            } else throw Error("Request error");
        } catch (error) {
            let message = `⚠️ Сервис недоступен`;
            bot.sendMessage(msg.chat.id, message);
            logger.error(error);
        }
    };

    static webcamHandler = async (bot, msg) => {
        await this.webcamGenericHandler(bot, msg, "webcam", "Первый этаж");
    };

    static webcam2Handler = async (bot, msg) => {
        await this.webcamGenericHandler(bot, msg, "webcam2", "Второй этаж");
    };

    static doorcamHandler = async (bot, msg) => {
        await this.webcamGenericHandler(bot, msg, "doorcam", "Входная дверь");
    };

    static webcamGenericHandler = async (bot, msg, path, prefix) => {
        if (!UsersHelper.hasRole(msg.from.username, "admin", "member")) return;

        try {
            let response = await (
                await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/${path}`)
            )?.arrayBuffer();

            let webcamImage = Buffer.from(response);

            if (webcamImage) await bot.sendPhoto(msg.chat.id, webcamImage);
            else throw Error("Empty webcam image");
        } catch (error) {
            let message = `⚠️ ${prefix}: Камера пока недоступна`;
            await bot.sendMessage(msg.chat.id, message);
            logger.error(error);
        }
    };

    static monitorHandler = async (bot, msg, notifyEmpty = false) => {
        try {
            let statusMessages = await this.queryStatusMonitor();

            if (!notifyEmpty && statusMessages.length === 0) return;

            let message =
                statusMessages.length > 0 ? TextGenerators.getMonitorMessagesList(statusMessages) : "Новых сообщений нет";

            bot.sendMessage(msg.chat.id, message);
        } catch (error) {
            let message = `⚠️ Не удалось получить статус, может, что-то с инетом, электричеством или le-fail?`;
            bot.sendMessage(msg.chat.id, message);
            logger.error(error);
        }
    };

    static queryStatusMonitor = async () => {
        return await (await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/statusmonitor`))?.json();
    };

    static enableStatusMonitor(bot) {
        setInterval(
            () => this.monitorHandler(bot, { chat: { id: botConfig.chats.test } }),
            embassyApiConfig.queryMonitorInterval
        );
    }

    static printersHandler = async (bot, msg) => {
        let message = TextGenerators.getPrintersInfo();
        let inlineKeyboard = [
            [
                {
                    text: "Статус Anette",
                    callback_data: JSON.stringify({ command: "/printerstatus anette" }),
                },
                {
                    text: "Статус Plumbus",
                    callback_data: JSON.stringify({ command: "/printerstatus plumbus" }),
                },
            ],
        ];

        bot.sendMessage(msg.chat.id, message, {
            reply_markup: {
                inline_keyboard: inlineKeyboard,
            },
        });
    };

    static printerStatusHandler = async (bot, msg, printername) => {
        try {
            var { status, thumbnailBuffer, cam } = await (
                await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/printer?printername=${printername}`)
            ).json();

            if (status && !status.error) var message = await TextGenerators.getPrinterStatus(status);
            else throw Error();
        } catch (error) {
            logger.error(error);
            message = `⚠️ Принтер пока недоступен`;
        } finally {
            if (cam) await bot.sendPhoto(msg.chat.id, Buffer.from(cam));

            let inlineKeyboard = [
                [
                    {
                        text: `Обновить статус ${printername}`,
                        callback_data: JSON.stringify({ command: `/printerstatus ${printername}` }),
                    },
                ],
            ];

            if (thumbnailBuffer)
                await bot.sendPhoto(msg.chat.id, Buffer.from(thumbnailBuffer), {
                    caption: message,
                    reply_markup: {
                        inline_keyboard: inlineKeyboard,
                    },
                });
            else
                await bot.sendMessage(msg.chat.id, message, {
                    reply_markup: {
                        inline_keyboard: inlineKeyboard,
                    },
                });
        }
    };

    static doorbellHandler = async (bot, msg) => {
        if (!UsersHelper.hasRole(msg.from.username, "admin", "member")) return;

        try {
            let status = await (await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/doorbell`))?.json();

            if (status && !status.error) var message = "🔔 Звоним в дверной звонок";
            else throw Error();
        } catch (error) {
            message = `🔕 Не получилось позвонить`;
            logger.error(error);
        } finally {
            bot.sendMessage(msg.chat.id, message);
        }
    };

    static sayinspaceHandler = async (bot, msg, text) => {
        try {
            if (!text) {
                bot.sendMessage(
                    msg.chat.id,
                    `🗣 С помощью этой команды можно сказать что-нибудь на динамике в спейсе, например #\`/say Привет, хакеры#\``
                );
                return;
            }

            let response = await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/sayinspace`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text }),
            });

            if (response.status === 200) await bot.sendMessage(msg.chat.id, "🗣 Сообщение отправлено на динамик");
            else throw Error("Failed to say in space");
        } catch (error) {
            let message = `⚠️ Не получилось сказать`;
            await bot.sendMessage(msg.chat.id, message);
            logger.error(error);
        }
    };

    static playinspaceHandler = async (bot, msg, link) => {
        try {
            if (!link) {
                bot.sendMessage(msg.chat.id, `🗣 С помощью этой команды можно воспроизвести любой звук по ссылке`);
                return;
            }

            let response = await fetchWithTimeout(`${embassyApiConfig.host}:${embassyApiConfig.port}/playinspace`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ link }),
            });

            if (response.status === 200) await bot.sendMessage(msg.chat.id, "🗣 Звук отправлен на динамик");
            else throw Error("Failed to play in space");
        } catch (error) {
            let message = `⚠️ Не получилось воспроизвести`;
            await bot.sendMessage(msg.chat.id, message);
            logger.error(error);
        }
    };
}

module.exports = EmbassyHanlers;
