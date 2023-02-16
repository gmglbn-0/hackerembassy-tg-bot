const StatusRepository = require("../../repositories/statusRepository");
const UsersRepository = require("../../repositories/usersRepository");
const TextGenerators = require("../../services/textGenerators");
const UsersHelper = require("../../services/usersHelper");
const BaseHandlers = require("./base");

class StatusHandlers extends BaseHandlers {
  constructor() {
    super();
  }

  autoinsideHandler(msg, mac) {
    let message = `Укажите валидный MAC адрес`;
    let username = msg.from.username;

    if (!mac || mac === "help") {
      message = `⏲ С помощью этой команды можно автоматически отмечаться в спейсе как только MAC адрес вашего устройства будет обнаружен в сети.
📌 При отсутствии активности устройства в сети спейса в течение ${
        this.botConfig.timeouts.out / 60000
      } минут произойдет автовыход юзера.
📌 При включенной фиче актуальный статус устройства в сети имеет приоритет над ручными командами входа/выхода.
⚠️ Для работы обязательно отключите рандомизацию MAC адреса для сети спейса.
      
#\`/autoinside mac_address#\` - Включить автовход и автовыход  
#\`/autoinside status#\` - Статус автовхода и автовыхода  
#\`/autoinside disable#\` - Выключить автовход и автовыход  
`;
    } else if (mac && /([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/.test(mac) && UsersRepository.setMAC(username, mac)) {
      message = `Автовход и автовыход активированы для юзера ${this.bot.formatUsername(
        username
      )} на MAC адрес ${mac}.
Не забудьте отключить рандомизацию MAC адреса для сети спейса
      `;
    } else if (mac === "disable") {
      UsersRepository.setMAC(username, null);
      message = `Автовход и автовыход выключены для юзера ${this.bot.formatUsername(username)}`;
    } else if (mac === "status") {
      let usermac = UsersRepository.getUser(username)?.mac;

      if (usermac)
        message = `Автовход и автовыход включены для юзера ${this.bot.formatUsername(username)} на MAC адрес ${usermac}`;
      else 
        message = `Автовход и автовыход выключены для юзера ${this.bot.formatUsername(username)}`;
    }

    this.bot.sendMessage(msg.chat.id, message);
  }

  statusHandler = (msg) => {
    let state = StatusRepository.getSpaceLastState();

    if (!state) {
      this.bot.sendMessage(msg.chat.id, `🔐 Статус спейса неопределен`);
      return;
    }

    let inside = StatusRepository.getPeopleInside();
    let statusMessage = TextGenerators.getStatusMessage(state, inside);
    let inlineKeyboard = state.open
      ? [
          [
            {
              text: "Я пришёл в спейс",
              callback_data: JSON.stringify({ command: "/in" }),
            },
            {
              text: "Я ушёл из спейса",
              callback_data: JSON.stringify({ command: "/out" }),
            },
          ],
          [
            {
              text: "Повторить команду",
              callback_data: JSON.stringify({ command: "/status" }),
            },
            {
              text: "Закрыть спейс",
              callback_data: JSON.stringify({ command: "/close" }),
            },
          ],
        ]
      : [
          [
            {
              text: "Повторить команду",
              callback_data: JSON.stringify({ command: "/status" }),
            },
            {
              text: "Открыть спейс",
              callback_data: JSON.stringify({ command: "/open" }),
            },
          ],
        ];

    this.bot.sendMessage(msg.chat.id, statusMessage, {
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    });
  };

  openHandler = (msg) => {
    if (!UsersHelper.hasRole(msg.from.username, "member")) return;
    let opendate = new Date();
    let state = {
      open: true,
      date: opendate,
      changedby: msg.from.username,
    };

    StatusRepository.pushSpaceState(state);

    let userstate = {
      inside: true,
      date: opendate,
      username: msg.from.username,
      type: StatusRepository.ChangeType.Opened

    };

    StatusRepository.pushPeopleState(userstate);

    let inlineKeyboard = [
      [
        {
          text: "Я тоже пришёл",
          callback_data: JSON.stringify({ command: "/in" }),
        },
        {
          text: "Закрыть снова",
          callback_data: JSON.stringify({ command: "/close" }),
        },
      ],
      [
        {
          text: "Кто внутри",
          callback_data: JSON.stringify({ command: "/status" }),
        },
      ],
    ];

    this.bot.sendMessage(
      msg.chat.id,
      `🔓 ${this.bot.formatUsername(state.changedby)} открыл спейс для гостей
Отличный повод зайти
      
🗓 ${state.date.toLocaleString()} `,
      {
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      }
    );
  };

  closeHandler = (msg) => {
    if (!UsersHelper.hasRole(msg.from.username, "member")) return;

    let state = {
      open: false,
      date: new Date(),
      changedby: msg.from.username,
    };

    StatusRepository.pushSpaceState(state);
    StatusRepository.evictPeople();

    let inlineKeyboard = [
      [
        {
          text: "Открыть снова",
          callback_data: JSON.stringify({ command: "/open" }),
        },
      ],
    ];

    this.bot.sendMessage(
      msg.chat.id,
      `🔒 ${this.bot.formatUsername(state.changedby)} закрыл спейс
Все отметившиеся отправлены домой
      
🗓 ${state.date.toLocaleString()}`,
      {
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      }
    );
  };

  inHandler = (msg) => {
    let eventDate = new Date();
    let user = msg.from.username ?? msg.from.first_name;
    let gotIn = this.LetIn(user, eventDate);
    let message = `🟢 ${this.bot.formatUsername(user)} пришел в спейс
🗓 ${eventDate.toLocaleString()} `;

    if (!gotIn) {
      message = "🔐 Сейчас спейс не готов принять гостей";
    }

    let inlineKeyboard = gotIn
      ? [
          [
            {
              text: "Я тоже пришёл",
              callback_data: JSON.stringify({ command: "/in" }),
            },
            {
              text: "А я уже ушёл",
              callback_data: JSON.stringify({ command: "/out" }),
            },
          ],
          [
            {
              text: "Кто внутри",
              callback_data: JSON.stringify({ command: "/status" }),
            },
          ],
        ]
      : [
          [
            {
              text: "Повторить команду",
              callback_data: JSON.stringify({ command: "/in" }),
            },
            {
              text: "Открыть спейс",
              callback_data: JSON.stringify({ command: "/open" }),
            },
          ],
        ];

    this.bot.sendMessage(msg.chat.id, message, {
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    });
  };

  outHandler = (msg) => {
    let eventDate = new Date();
    let gotOut = this.LetOut(msg.from.username, eventDate);
    let message = `🔴 ${this.bot.formatUsername(msg.from.username)} ушел из спейса
🗓 ${eventDate.toLocaleString()} `;

    if (!gotOut) {
      message = "🔐 Странно, ты же не должен был быть внутри...";
    }

    let inlineKeyboard = gotOut
      ? [
          [
            {
              text: "Я тоже ушёл",
              callback_data: JSON.stringify({ command: "/out" }),
            },
            {
              text: "А я пришёл",
              callback_data: JSON.stringify({ command: "/in" }),
            },
          ],
          [
            {
              text: "Кто внутри",
              callback_data: JSON.stringify({ command: "/status" }),
            },
          ],
        ]
      : [
          [
            {
              text: "Повторить команду",
              callback_data: JSON.stringify({ command: "/out" }),
            },
            {
              text: "Открыть спейс",
              callback_data: JSON.stringify({ command: "/open" }),
            },
          ],
        ];

    this.bot.sendMessage(msg.chat.id, message, {
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    });
  };

  inForceHandler = (msg, username) => {
    if (!UsersHelper.hasRole(msg.from.username, "member")) return;
    username = username.replace("@", "");
    let eventDate = new Date();

    let gotIn = this.LetIn(username, eventDate, true);

    let message = `🟢 ${this.bot.formatUsername(msg.from.username)} привёл ${this.bot.formatUsername(username)} в спейс 
🗓 ${eventDate.toLocaleString()} `;

    if (!gotIn) {
      message = "🔐 Сорян, ты не можете сейчас его привести";
    }
    this.bot.sendMessage(msg.chat.id, message);
  };

  outForceHandler = (msg, username) => {
    if (!UsersHelper.hasRole(msg.from.username, "member")) return;
    let eventDate = new Date();
    username = username.replace("@", "");
    let gotOut = this.LetOut(username, eventDate, true);

    let message = `🔴 ${this.bot.formatUsername(msg.from.username)} отправил домой ${this.bot.formatUsername(username)}
🗓 ${eventDate.toLocaleString()} `;

    if (!gotOut) {
      message = "🔐 Ээ нее, ты не можешь его отправить домой";
    }

    this.bot.sendMessage(msg.chat.id, message);
  };

  LetIn(username, date, force = false) {
    // check that space is open
    let state = StatusRepository.getSpaceLastState();
    
    if (!state?.open && !UsersHelper.hasRole(username, "member") && !force) return false;

    let userstate = {
      inside: true,
      date: date,
      username: username,
      type: force ? StatusRepository.ChangeType.Force : StatusRepository.ChangeType.Manual
    };

    StatusRepository.pushPeopleState(userstate);

    return true;
  }

  LetOut(username, date, force = false) {
    let state = StatusRepository.getSpaceLastState();

    if (!state?.open && !UsersHelper.hasRole(username, "member") && !force) return false;

    let userstate = {
      inside: false,
      date: date,
      username: username,
      type: force ? StatusRepository.ChangeType.Force : StatusRepository.ChangeType.Manual
    };

    StatusRepository.pushPeopleState(userstate);

    return true;
  }
}

module.exports = StatusHandlers;
