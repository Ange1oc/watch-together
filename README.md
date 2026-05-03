# Rezka Sync Server

WebSocket сервер для синхронизированного просмотра видео на rezka-ua.tv.

## Деплой

### Railway (бесплатно)
1. Зарегистрируйтесь на [railway.app](https://railway.app)
2. Создайте новый проект → "Deploy from GitHub repo"
3. Подключите этот репозиторий (папку `server/`)
4. Railway автоматически запустит `npm start`
5. Скопируйте URL вида `https://xxx.up.railway.app`
6. В расширении укажите: `wss://xxx.up.railway.app`

### Render (бесплатно)
1. Зарегистрируйтесь на [render.com](https://render.com)
2. New → Web Service → подключите репозиторий
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Скопируйте URL вида `https://xxx.onrender.com`
6. В расширении укажите: `wss://xxx.onrender.com`

> **Внимание:** На бесплатном тарифе Render сервер засыпает через 15 минут бездействия.
> При первом подключении может потребоваться 30–60 секунд на "пробуждение".

### Локально
```bash
npm install
npm start
# или для разработки:
npm run dev
```

## API

### WebSocket-события

**Клиент → Сервер:**
| Тип | Поля | Описание |
|-----|------|----------|
| `join` | `room`, `username` | Войти в комнату |
| `play` | `time` | Воспроизведение |
| `pause` | `time` | Пауза |
| `seek` | `time` | Перемотка |
| `chat` | `message` | Сообщение в чат |
| `ping` | — | Пинг |

**Сервер → Клиент:**
| Тип | Поля | Описание |
|-----|------|----------|
| `room_joined` | `room`, `users`, `currentTime`, `playing` | Подтверждение входа + текущее состояние |
| `user_joined` | `username`, `users` | Кто-то вошёл |
| `user_left` | `username`, `users` | Кто-то вышел |
| `play` | `time`, `username` | Команда воспроизведения |
| `pause` | `time`, `username` | Команда паузы |
| `seek` | `time`, `username` | Команда перемотки |
| `chat` | `message`, `username` | Сообщение в чат |

### HTTP
- `GET /` — статус сервера
- `GET /health` — healthcheck
