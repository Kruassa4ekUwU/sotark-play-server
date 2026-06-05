# Sotark Play — Server

REST API для магазина Android-приложений.

## Запуск

```bash
npm install
npm start
```

## API

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/apps` | Список приложений (`?q=`, `?category=`, `?sort=downloads\|rating\|newest\|name`) |
| GET | `/apps/:id` | Одно приложение |
| POST | `/apps` | Опубликовать (multipart: `apk`, `icon`, поля) |
| PUT | `/apps/:id` | Обновить |
| DELETE | `/apps/:id` | Удалить |
| GET | `/apps/:id/download` | Скачать APK |
| POST | `/apps/:id/screenshots` | Загрузить скриншоты |
| GET | `/apps/:id/reviews` | Отзывы |
| POST | `/apps/:id/reviews` | Добавить отзыв |
| GET | `/categories` | Все категории |
| GET | `/top` | Топ-10 |
| GET | `/suggest?q=` | Подсказки поиска |

## Деплой на Railway

1. Подключи этот репозиторий в [Railway](https://railway.app)
2. Всё настроится автоматически — `npm start` запустит сервер
