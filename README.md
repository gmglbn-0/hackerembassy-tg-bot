Бот для решения различных спейсовских задач. Пока реализованы:
- Базовое управление проектами и донатами
- Открытие и закрытие спейса, отмечание прихода ухода участников
- Базовое управление пользователями и ролями

Для локальной разработки:
1. npm install
2. Скопируйте в папке data файл sample.db и назовите его data.db
3. Установите env переменную (можно создать файл .env со следующим содержимым)
        HACKERBOTTOKEN="Токен тестового бота"
4. npm run dev
