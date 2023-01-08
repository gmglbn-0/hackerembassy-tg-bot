require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const StatusRepository = require("./repositories/statusRepository");
const UsersRepository = require("./repositories/usersRepository");
const FundsRepository = require("./repositories/fundsRepository");
const TextGenerators = require("./services/textGenerators");
const UsersHelper = require("./services/usersHelper");
const ExportHelper = require("./services/export");
const Commands = require("./commands");
const CoinsHelper = require("./data/coins/coins");
const { initGlobalModifiers, tag } = require("./global");

const TOKEN = process.env["HACKERBOTTOKEN"];
const IsDebug = process.env["BOTDEBUG"] === "true";
process.env.TZ = "Asia/Yerevan";

const bot = new TelegramBot(TOKEN, { polling: true });
initGlobalModifiers(bot);

bot.onText(/^\/exportDonut(@.+?)? (.*\S)$/, async (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin", "accountant")) return;

  let fundName = match[2];

  let imageBuffer = await ExportHelper.exportFundToDonut(fundName);

  if (!imageBuffer?.length) {
    bot.sendMessage(msg.chat.id, "Нечего экспортировать");
    return;
  }

  bot.sendPhoto(msg.chat.id, imageBuffer);
});


bot.onText(/^\/(start|help)(@.+?)?$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🛠 Привет хакерчан. Я новый бот для менеджмента всяких процессов в спейсе. 
[Я еще нахожусь в разработке, ты можешь поучаствовать в моем развитии в репозитории на гитхабе спейса].
Держи мой список команд:\n` +
      UsersHelper.getAvailableCommands(msg.from.username) +
      `${Commands.GlobalModifiers}`, {parse_mode:"Markdown"}
  );
});

bot.onText(/^\/(about)(@.+?)?$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🏫 Hacker Embassy (Ереванский Хакспейс) - это пространство, где собираются единомышленники, увлеченные технологиями и творчеством. Мы вместе работаем над проектами, делимся идеями и знаниями, просто общаемся.

💻 Ты можешь почитать о нас подробнее на нашем сайте https://hackerembassy.site/

🍕 Мы всегда рады новым резидентам. Хочешь узнать, как стать участником? Жми команду /join`
  );
});

bot.onText(/^\/(join)(@.+?)?$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🧑🏻‍🏫 Если вы находитесь в Ереване, увлечены технологиями и ищете единомышленников, заходите к нам.
- Мы проводим регулярный день открытых дверей каждую пятницу в 20.00.
- Часто по понедельникам в 20.00 мы проводим музыкальные встречи: приносим гитары, играем в Rocksmith и джемим.
- В любой другой день спейс тоже может принять гостей, вводи команду /status чтобы узнать открыт ли спейс и есть ли там кто-нибудь.

💸 Посещения свободные (бесплатные), но любые донаты на помощь нашим проектам и аренду дома очень приветствуются.
Подробнее можно узнать по команде /donate

🔑 Если вы хотите стать постоянным участником - полноценным резидентом сообщества, т.е. иметь свой ключ, своё место для хранения вещей (инструменты, сервера и.т.п.), участвовать в принятии решений о развитии спейса,\
 то наши требования просты:
- Дружелюбность и неконфликтность.
- Готовность участвовать в жизни сообщества.
- Регулярные пожертвования (естественно в рамках ваших возможностей).

🧙🏻‍♂️ Обратитесь к любому резиденту спейса, он представит вашу кандидатуру Совету Спейса.
`
  );
});

bot.onText(/^\/(donate)(@.+?)?$/, (msg) => {
  let accountants = UsersRepository.getUsersByRole("accountant");
  let accountantsList = TextGenerators.getAccountsList(accountants);

  bot.sendMessage(
    msg.chat.id,
    `💸 Хакспейс не является коммерческим проектом и существует исключительно на пожертвования участников.
Мы вносим свой вклад в развитие хакспейса: оплата аренды и коммуналки, забота о пространстве, помощь в приобретении оборудования.
Мы будем рады любой поддержке. 

Задонатить нам можно следующими способами:
💳 Банковская карта Visa/Mastercard Армении.
      /donateCard
🪙 Криптовалюта (по следующим командам)
      /donateBTH
      /donateETH
      /donateUSDC
      /donateUSDT
💵 Наличкой при встрече (самый лучший вариант).
      /donateCash

📊 Увидеть наши текущие сборы и ваш вклад можно по команде /funds

💌 По вопросам доната обращайтесь к нашим бухгалтерам, они помогут.\n` + accountantsList
  );
});

// State
bot.onText(/^\/status(@.+?)?$/, (msg) => {
  let state = StatusRepository.getSpaceLastState();

  if (!state) {
    bot.sendMessage(msg.chat.id, `🔐 Статус спейса неопределен 🔐`);
    return;
  }

  let inside = StatusRepository.getPeopleInside();

  let stateText = state.open ? "открыт" : "закрыт";
  let stateEmoji = state.open ? "🔐" : "🔒";
  let insideText =
    inside.length > 0
      ? "👨‍💻 Внутри отметились:\n"
      : "🛌 Внутри никто не отметился\n";
  for (const user of inside) {
    insideText += `${tag()}${user.username}\n`;
  }
  bot.sendMessage(
    msg.chat.id,
    `${stateEmoji} Спейс ${stateText} юзером ${tag()}${state.changedby} ${stateEmoji}
🗓 ${state.date.toLocaleString()}
` + insideText
  );
});

bot.onText(/^\/open(@.+?)?$/, (msg) => {
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
  };

  StatusRepository.pushPeopleState(userstate);

  bot.sendMessage(
    msg.chat.id,
    `🔐 Юзер ${tag()}${state.changedby} открыл спейс 🔐
🗓 ${state.date.toLocaleString()} `
  );
});

bot.onText(/^\/close(@.+?)?$/, (msg) => {
  if (!UsersHelper.hasRole(msg.from.username, "member")) return;
  let state = {
    open: false,
    date: new Date(),
    changedby: msg.from.username,
  };

  StatusRepository.pushSpaceState(state);
  StatusRepository.evictPeople();

  bot.sendMessage(
    msg.chat.id,
    `🔓 Юзер ${tag()}${state.changedby} закрыл спейс 🔓
🗓 ${state.date.toLocaleString()}`
  );
});

bot.onText(/^\/in(@.+?)?$/, (msg) => {
  let eventDate = new Date();
  let gotIn = LetIn(msg.from.username, eventDate);
  let message = `🟢 Юзер ${tag()}${msg.from.username} пришел в спейс 🟢
🗓 ${eventDate.toLocaleString()} `;

  if (!gotIn){
    message = "🔐 Откройте cпейс прежде чем туда входить! 🔐";
  }

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/inForce(@.+?)? (\S+)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "member")) return;
  let username = match[2].replace("@", "");
  let eventDate = new Date();

  let gotIn = LetIn(username, eventDate);

  let message = `🟢 ${tag()}${
    msg.from.username
  } привёл юзера ${tag()}${username} в спейс  🟢
🗓 ${eventDate.toLocaleString()} `

  if (!gotIn){
    message = "🔐 Откройте cпейс прежде чем туда кого-то пускать! 🔐";
  }
  bot.sendMessage(msg.chat.id,message);
});

bot.onText(/^\/out(@.+?)?$/, (msg) => {
  let eventDate = new Date();
  let gotOut = LetOut(msg.from.username, eventDate);
  let message = `🔴 Юзер ${tag()}${msg.from.username} ушел из спейса 🔴
🗓 ${eventDate.toLocaleString()} `

  if (!gotOut){
    message = "🔐 Спейс же закрыт, как ты там оказался? Через окно залез? 🔐";
  }

  bot.sendMessage(msg.chat.id,message);
});

bot.onText(/^\/outForce(@.+?)? (\S+)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "member")) return;
  let eventDate = new Date();
  let username = match[2].replace("@", "");
  let gotOut = LetOut(username, eventDate);

  let message = `🔴 ${tag()}${
    msg.from.username
  } выпроводил юзера ${tag()}${username} из спейса 🔴
🗓 ${eventDate.toLocaleString()} `;

  if (!gotOut){
    message = "🔐 А что тот делал в закрытом спейсе, ты его там запер? 🔐";
  }

  bot.sendMessage(msg.chat.id,message);
});

function LetIn(username, date) {
  // check that space is open
  let state = StatusRepository.getSpaceLastState();
  if (!state?.open) {
    return false;
  }

  let userstate = {
    inside: true,
    date: date,
    username: username,
  };

  StatusRepository.pushPeopleState(userstate);

  return true;
}

function LetOut(username, date) {
  let state = StatusRepository.getSpaceLastState();
  if (!state?.open) {
    return false;
  }

  let userstate = {
    inside: false,
    date: date,
    username: username,
  };

  StatusRepository.pushPeopleState(userstate);

  return true;
}

// User management
bot.onText(/^\/getUsers(@.+?)?$/, (msg, _) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin")) return;

  let users = UsersRepository.getUsers();
  let userList = "";
  for (const user of users) {
    userList += `${tag()}${user.username} ${user.roles}\n`;
  }

  bot.sendMessage(msg.chat.id, `Текущие пользователи:\n` + userList);
});

bot.onText(/^\/addUser(@.+?)? (\S+?) as (\S+)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin")) return;

  let username = match[2].replace("@", "");
  let roles = match[3].split("|");

  let success = UsersRepository.addUser(username, roles);
  let message = success
    ? `Пользователь ${tag()}${username} добавлен как ${roles}`
    : `Не удалось добавить пользователя (может он уже есть?)`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/updateRoles(@.+?)? of (\S+?) to (\S+)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin")) return;

  let username = match[2].replace("@", "");
  let roles = match[3].split("|");

  let success = UsersRepository.updateRoles(username, roles);
  let message = success
    ? `Роли ${tag()}${username} установлены как ${roles}`
    : `Не удалось обновить роли`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/removeUser(@.+?)? (\S+)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin")) return;

  let username = match[2].replace("@", "");

  let success = UsersRepository.removeUser(username);
  let message = success
    ? `Пользователь ${tag()}${username} удален`
    : `Не удалось удалить пользователя (может его и не было?)`;

  bot.sendMessage(msg.chat.id, message);
});
//funds

bot.onText(/^\/funds(@.+?)?( -nocommands)?$/, async (msg, match) => {
  let funds = FundsRepository.getfunds().filter((p) => p.status === "open");
  let donations = FundsRepository.getDonations();
  let needCommands = !(match[2]?.length > 0);
  let addCommands = needCommands ? UsersHelper.hasRole(msg.from.username, "admin", "accountant") : false;
  let list = await TextGenerators.createFundList(funds, donations, addCommands);

  bot.sendMessage(msg.chat.id, `⚒ Вот наши текущие сборы:

${list}💸 Чтобы узнать, как нам помочь - жми /donate`, {parse_mode:"Markdown"});
});

bot.onText(/^\/fundsAll(@.+?)?$/, async (msg, match) => {
  let funds = FundsRepository.getfunds();
  let donations = FundsRepository.getDonations();
  let needCommands = !(match[2]?.length > 0);
  let addCommands = needCommands ? UsersHelper.hasRole(msg.from.username, "admin", "accountant") : false;
  let list = await TextGenerators.createFundList(funds, donations, addCommands);

  bot.sendMessage(msg.chat.id, "⚒ Вот все наши сборы:\n\n" + list, {parse_mode:"Markdown"});
});

bot.onText(/^\/addFund(@.+?)? (.*\S) with target (\d+)(\D*)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin", "accountant")) return;

  let fundName = match[2];
  let targetValue = match[3];

  let success = FundsRepository.addfund(fundName, targetValue);
  let message = success
    ? `Добавлен сбор ${fundName} с целью в ${targetValue} AMD`
    : `Не удалось добавить сбор (может он уже есть?)`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/removeFund(@.+?)? (.*\S)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin", "accountant")) return;

  let fundName = match[2];

  let success = FundsRepository.removefund(fundName);
  let message = success ? `Удален сбор ${fundName}` : `Не удалось удалить сбор`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/exportFund(@.+?)? (.*\S)$/, async (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin", "accountant")) return;

  let fundName = match[2];

  let csvBuffer = await ExportHelper.exportFundToCSV(fundName);

  if (!csvBuffer?.length) {
    bot.sendMessage(msg.chat.id, "Нечего экспортировать");
    return;
  }

  const fileOptions = {
    filename: `${fundName} donations.csv`,
    contentType: "text/csv",
  };

  bot.sendDocument(msg.chat.id, csvBuffer, {}, fileOptions);
});

bot.onText(/^\/closeFund(@.+?)? (.*\S)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin", "accountant")) return;
  let fundName = match[2];

  let success = FundsRepository.closefund(fundName);
  let message = success ? `Закрыт сбор ${fundName}` : `Не удалось закрыть сбор`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/changeFundStatus(@.+?)? of (.*\S) to (.*\S)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "admin", "accountant")) return;

  let fundName = match[2];
  let fundStatus = match[3].toLowerCase();

  let success = FundsRepository.changefundStatus(fundName, fundStatus);
  let message = success
    ? `Статус сбора ${fundName} изменен на ${fundStatus}`
    : `Не удалось изменить статус сбора`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(
  /^\/addDonation(@.+?)? (\d+?)(\D*?) from (\S+?) to (.*\S)$/,
  async (msg, match) => {
    if (!UsersHelper.hasRole(msg.from.username, "accountant")) return;

    let value = match[2];
    let currency = match[3];
    let userName = match[4].replace("@", "");
    let fundName = match[5];

    let success = FundsRepository.addDonationTo(fundName, userName, value);
    let message = success
      ? `Добавлен донат ${value}${currency} от ${tag()}${userName} в сбор ${fundName}`
      : `Не удалось добавить донат`;

    bot.sendMessage(msg.chat.id, message);
  }
);

bot.onText(/^\/removeDonation(@.+?)? (\d+)$/, (msg, match) => {
  if (!UsersHelper.hasRole(msg.from.username, "accountant")) return;

  let donationId = match[2];

  let success = FundsRepository.removeDonationById(donationId);
  let message = success
    ? `Удален донат [id:${donationId}]`
    : `Не удалось удалить донат (может его и не было?)`;

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/^\/donate(Cash|Card)(@.+?)?$/, async (msg, match) => {
  let accountants = UsersRepository.getUsersByRole("accountant");
  let accountantsList = TextGenerators.getAccountsList(accountants);

  let type = match[1];

  bot.sendMessage(msg.chat.id, `💌Для того, чтобы задонатить этим способом, напишите нашим бухгалтерам. Они подскажут вам текущие реквизиты или вы сможете договориться о времени и месте передачи. 

Вот они, слева-направо:
${accountantsList}
🛍 Если хочешь задонатить натурой или другим способом - жми /donate`);
});

bot.onText(/^\/donate(BTH|ETH|USDC|USDT)(@.+?)?$/, async (msg, match) => {
  let coinname = match[1].toLowerCase();
  let buffer = await CoinsHelper.getQR(coinname);
  let coin = CoinsHelper.getCoinDefinition(coinname);

  bot.sendPhoto(msg.chat.id, buffer, {
    caption: `🪙 Используй этот QR код или адрес ниже, чтобы задонатить нам в ${coin.fullname}.

⚠️ Обрати внимание, что сеть ${coin.network} и ты используешь правильный адрес:
\`${coin.address}\`

💌 Не забудь написать бухгалтеру, что ты задонатил(ла/ло) и скинуть код транзакции или ссылку
в https://mempool.space/ или аналогичном сервисе

🛍 Если хочешь задонатить натурой (ohh my) или другим способом - жми /donate`,
  parse_mode:"Markdown"
  });
});

// Debug echoing of received messages
IsDebug &&
  bot.on("message", (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `Debug: Received from ${msg.chat.id} message ${msg.text}`
    );
  });
