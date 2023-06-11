const { Convert } = require("easy-currencies");
const CryptoConvert = require("crypto-convert").default;
const config = require("config");
const currencyConfig = config.get("currency");

const CurrencyFractionDigits = [
    { currency: "AMD", fraction: 0 },
    { currency: "RUB", fraction: 0 },
    { currency: "USD", fraction: 2 },
    { currency: "USDT", fraction: 2 },
    { currency: "USDC", fraction: 2 },
    { currency: "EUR", fraction: 2 },
    { currency: "BTC", fraction: 8 },
    { currency: "ETH", fraction: 6 },
];

const CurrencySymbolToCode = {
    ["$"]: "USD",
    ["€"]: "EUR",
    ["£"]: "GBP",
    ["֏"]: "AMD",
    ["₽"]: "RUB",
};

/**
 * @param {number} value
 * @param {string} currency
 */
function formatValueForCurrency(value, currency) {
    let fraction = CurrencyFractionDigits.find(fd => fd.currency === currency)?.fraction ?? 4;
    return Number(value.toFixed(fraction));
}

/**
 * @param {string} value
 */
function parseMoneyValue(value) {
    return Number(value.replaceAll(/(k|тыс|тысяч|т)/g, "000").replaceAll(",", ""));
}

/**
 * @param {string} currencyInput
 */
async function prepareCurrency(currencyInput) {
    if (!currencyInput.length) return currencyConfig.default;

    if (Object.keys(CurrencySymbolToCode).includes(currencyInput)) return CurrencySymbolToCode[currencyInput];

    let outputCurrency = currencyInput.toUpperCase();

    // We don't need nonconvertable currencies
    if (await convertCurrency(1, outputCurrency, "USD")) return outputCurrency;

    return null;
}

const convert = new CryptoConvert({
    cryptoInterval: currencyConfig.cryptoUpdateInterval,
    fiatInterval: currencyConfig.fiatUpdateInterval,
    calculateAverage: true,
    binance: true,
});

(async function () {
    await convert.ready(); //Wait for the initial cache to load
    await convert.addCurrency(
        "AMD",
        "USD",
        async () => await Convert(1).from("AMD").to("USD"),
        currencyConfig.fiatUpdateInterval
    );
})();

/**
 * @param {number} amount
 * @param {string | number} from
 * @param {string} to
 * @returns {Promise<number>}
 */
async function convertCurrency(amount, from, to) {
    try {
        await convert.ready();

        return await convert[from][to](amount);
    } catch (error) {
        return undefined;
    }
}

module.exports = { CurrencyFractionDigits, convertCurrency, formatValueForCurrency, prepareCurrency, parseMoneyValue };
