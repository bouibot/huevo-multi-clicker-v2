// bot.mjs - Telegram-интерфейс: диалог добавления аккаунта, ручное решение капчи,
// управление аккаунтами и админ-панель (аккаунт/сумма комиссии, статистика,
// рассылка /broadcast, мульти-админка).
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { S } from './db.mjs';
import {
  OWNER_ID, COMMISSION_AMOUNT_DEFAULT, CAPTCHA_WAIT_MS,
  COMMUNITY_TG, COMMUNITY_FARM, BROADCAST_DELAY_MS,
} from './config.mjs';
import { sleep } from './config.mjs';

const STATUS_RU = {
  [S.RUNNING]: '🟢 фармит',
  [S.LOGGING]: '🟡 логинится',
  [S.WAITING_CAPTCHA]: '🟠 ждёт капчу',
  [S.NEED_LOGIN]: '🔑 нужен перелогин',
  [S.CAPPED]: '🌤 дневной кап',
  [S.LOCKED]: '🔒 вход залочен',
  [S.ERROR]: '🔴 ошибка',
  [S.STOPPED]: '⏸ остановлен',
  new: '⚪️ новый',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('ru-RU'));

export function createBot(token, db, engine) {
  if (!token) throw new Error('BOT_TOKEN не задан (.env)');
  const bot = new Bot(token);

  // chatId → { stage: 'user'|'pass'|'adm-acc'|'adm-amt'|'adm-addadmin'|'bc-text'|'bc-confirm'|'pw', ... }
  const flows = new Map();

  const notifyUser = (chatId, text) => {
    if (chatId) bot.api.sendMessage(chatId, text).catch(() => {});
  };
  // HTML-сообщение с инлайн-клавиатурой (для кнопки «Перелогиниться» из engine)
  const notifySend = (chatId, text, kb) => {
    if (chatId) bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  };
  // админам (владелец из .env + все, кого добавили): один текст → всем
  const adminIds = () => {
    const ids = new Set();
    if (OWNER_ID) ids.add(OWNER_ID);
    for (const a of db.allAdmins()) ids.add(a.tg_user_id);
    return [...ids];
  };
  const notifyAdmin = async (text) => {
    for (const id of adminIds()) bot.api.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});
  };

  // мост: engine вызывает captcha.request(chatId, imageB64, login) → Promise<код|null>.
  // Фото уходит юзеру, ожидания капчи копятся в FIFO на чат: первый ответ = первая капча.
  const captchaWaiters = new Map(); // chatId → [waiter]
  engine.captcha.request = (chatId, imageB64, username) =>
    new Promise((resolve) => {
      const list = captchaWaiters.get(chatId) ?? [];
      const w = {
        user: username,
        resolve(code) {
          clearTimeout(w.timer);
          const rest = (captchaWaiters.get(chatId) ?? []).filter((x) => x !== w);
          rest.length ? captchaWaiters.set(chatId, rest) : captchaWaiters.delete(chatId);
          const clean = code && String(code).trim();
          resolve(clean || null);
        },
      };
      w.timer = setTimeout(() => {
        w.resolve(null);
        notifyUser(
          chatId,
          `⏳ ${username}: код капчи не получил за ${CAPTCHA_WAIT_MS / 60000} мин - попробую позже.`
        );
      }, CAPTCHA_WAIT_MS);
      list.push(w);
      captchaWaiters.set(chatId, list);
      console.log(`[bot] капча → chat ${chatId} (${list.length} в очереди)`);
      bot.api
        .sendPhoto(chatId, new InputFile(Buffer.from(imageB64, 'base64')), {
          caption:
            `🧩 Капча для <b>${esc(username)}</b>.\n` +
            `Отправь код одним сообщением (на это ${CAPTCHA_WAIT_MS / 60000} мин).\n` +
            `Не можешь разобрать - жми «🔄 Другая капча».`,
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔄 Другая капча', `capregen:${chatId}`),
        })
        .catch(() => w.resolve(null));
    });
  // отмена всех ожиданий капчи конкретного аккаунта (когда юзер остановил его в боте)
  engine.captcha.cancel = (username) => {
    if (!username) return;
    for (const [chatId, list] of captchaWaiters) {
      for (const w of list.filter((x) => x.user === username)) w.resolve(null);
    }
  };

  // -- helpers --
  const MENU = () =>
    new InlineKeyboard().text('➕ Добавить аккаунт', 'add').row().text('📋 Мои аккаунты', 'accs');

  // кнопки «подпишись на сообщества» под /start
  const SUBSCRIBE_KB = () =>
    new InlineKeyboard().url('📢 Telegram-канал', COMMUNITY_TG).url('🍀 huevo autofarm', COMMUNITY_FARM);

  function accText(r) {
    const st = STATUS_RU[r.status] ?? r.status;
    let t = `${esc(st)} - <b>${esc(r.username)}</b>`;
    if (r.balance != null) t += ` - ${fmt(r.balance)} 🪙`;
    const paid = r.commission_paid ? '✅ отправлена' : '-';
    t += `\nсегодня: +${fmt(r.earned_today)} · комиссия: ${paid}`;
    if (r.status_note && r.status !== S.RUNNING) t += `\n<i>${esc(r.status_note)}</i>`;
    return t;
  }

  function accKeyboard(r) {
    const kb = new InlineKeyboard();
    if (r.status === S.STOPPED) {
      kb.text('▶️ Запустить', `acc:${r.id}:start`).text('🗑', `accdel:${r.id}`);
    } else {
      kb.text('⏸ Остановить', `acc:${r.id}:stop`).text('🗑', `accdel:${r.id}`);
    }
    kb.row().text('🔑 Сменить пароль', `accpw:${r.id}`);
    return kb;
  }

  function accountsMessage(rows) {
    if (!rows.length) {
      return { text: 'Аккаунтов пока нет - добавь первый.', keyboard: MENU() };
    }
    let text = '📋 <b>Мои аккаунты</b>\n\n';
    const kb = new InlineKeyboard();
    for (const r of rows) {
      const st = STATUS_RU[r.status] ?? r.status;
      text += `${st} · <b>${esc(r.username)}</b>` +
        (r.balance != null ? ` · ${fmt(r.balance)} 🪙` : '') +
        `\n<i>сегодня +${fmt(r.earned_today)} · комиссия ${r.commission_paid ? '✅' : '-'}</i>\n\n`;
      if (r.status === S.STOPPED) kb.text(`▶️ ${r.username}`, `acc:${r.id}:start`).text('🗑', `accdel:${r.id}`);
      else kb.text(`⏸ ${r.username}`, `acc:${r.id}:stop`).text('🗑', `accdel:${r.id}`);
      kb.text('🔑', `accpw:${r.id}`).row();
    }
    kb.text('➕ Добавить аккаунт', 'add');
    return { text, keyboard: kb };
  }

  async function sendAccounts(ctx) {
    const rows = db.accountsOfUser(ctx.from.id);
    const { text, keyboard } = accountsMessage(rows);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // запоминаем каждого юзера бота (нужно для /broadcast)
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat?.type === 'private') {
      try { db.upsertUser(ctx.from.id, ctx.chat.id, ctx.from.username, ctx.from.first_name); } catch {}
    }
    return next();
  });

  // -- права: владелец (OWNER_ID из .env / claim) + админы из БД --
  function isOwner(userId) {
    if (userId && userId === OWNER_ID) return true;
    return db.adminRole(userId) === 'owner';
  }
  const isAdmin = (userId) =>
    !userId ? false : isOwner(userId) || db.isAdmin(userId);

  // если владельца нет нигде (нет OWNER_ID и пусто в БД) - первый, кто вызвал /admin, становится владельцем (claim)
  function claimOwner(ctx) {
    if (OWNER_ID || db.allAdmins().length) return;
    db.addAdmin(ctx.from.id, 'owner', null);
    console.log(`[bot] владелец: claim id ${ctx.from.id}`);
  }

  // -- команды --
  bot.command('start', (ctx) =>
    ctx.reply(
      '🥚 <b>huevo мульти-кликер</b>\n\n' +
        'Добавь аккаунт - бот сам залогинится (капчу решаешь ты) и фармит копилку.\n' +
        'После первых 10 000 монеток за день бот переводит их сервису (комиссия) - спасибо за услугу!\n\n' +
        '<b>⚠️ Просьба:</b> подпишись на наши сообщества - так мы развиваем сервис:\n' +
        `• ${COMMUNITY_TG}\n• ${COMMUNITY_FARM}`,
      { parse_mode: 'HTML', reply_markup: SUBSCRIBE_KB() }
    )
  );
  bot.command('help', (ctx) => {
    const t =
      '/start - меню\n' +
      '/add - добавить аккаунт\n' +
      '/accounts - мои аккаунты\n' +
      '/cancel - прервать ввод';
    if (isAdmin(ctx.from?.id)) {
      return ctx.reply(t + '\n\n<i>Админ:</i>\n/admin - панель админа\n/broadcast - рассылка всем', { parse_mode: 'HTML' });
    }
    return ctx.reply(t);
  });
  bot.command('add', (ctx) => {
    flows.set(ctx.chat.id, { stage: 'user' });
    return ctx.reply('👤 Логин аккаунта huevo.su: (или /cancel)');
  });
  bot.command('accounts', (ctx) => sendAccounts(ctx));
  bot.command('cancel', (ctx) => {
    const flow = flows.get(ctx.chat.id);
    flows.delete(ctx.chat.id);
    const ws = captchaWaiters.get(ctx.chat.id);
    if (ws?.length) for (const w of [...ws]) w.resolve(null);
    if (flow || ws?.length) {
      return ctx.reply('❌ Отменено.', {
        reply_markup: flow?.stage?.startsWith('adm') || flow?.stage?.startsWith('bc') ? adminKeyboard(ctx.from.id) : MENU(),
      });
    }
    return ctx.reply('Нечего отменять.', { reply_markup: MENU() });
  });

  // -- кнопки-меню --
  bot.callbackQuery('add', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'user' });
    await ctx.reply('👤 Логин аккаунта huevo.su: (или /cancel)');
  });
  bot.callbackQuery('accs', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await sendAccounts(ctx);
  });

  // старт/стоп/удаление аккаунта (только владелец учётки)
  bot.callbackQuery(/^acc:(\d+):(start|stop)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const action = ctx.match[2];
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    if (action === 'stop') {
      if (row.status !== S.STOPPED) {
        await engine.stop(id, true);
        notifyUser(row.tg_chat_id, `⏸ ${row.username}: кликер остановлен.`);
      }
    } else if (row.status === S.STOPPED) {
      engine.start(id, row);
    }
    const fresh = db.getAccount(id);
    await ctx.reply(accText(fresh), { parse_mode: 'HTML', reply_markup: accKeyboard(fresh) });
  });

  bot.callbackQuery(/^accdel:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(`🗑 Удалить <b>${esc(row.username)}</b>? Клики прекратятся, данные сотрутся.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('✅ Удалить', `accdel:${id}:yes`).text('❌ Оставить', 'accs'),
    });
  });

  bot.callbackQuery(/^accdel:(\d+):yes$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    await engine.remove(id);
    await ctx.reply(`🗑 ${row.username}: удалён.`, { reply_markup: MENU() });
  });

  // -- смена пароля аккаунта --
  bot.callbackQuery(/^accpw:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'pw', accId: id });
    await ctx.reply(`🔐 Новый пароль для <b>${esc(row.username)}</b>: (или /cancel)`, { parse_mode: 'HTML' });
  });

  // -- приём капчи + диалоги ввода (текст) --
  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const t = ctx.message.text.trim();

    // 1) жду код капчи - первый ответивший текст в чате уходит первому в очереди
    const waiters = captchaWaiters.get(chatId);
    if (waiters?.length) {
      console.log(`[bot] код принят от chat ${chatId} (в очереди капч: ${waiters.length})`);
      waiters[0].resolve(t);
      return;
    }

    const flow = flows.get(chatId);
    if (!flow) return next();

    if (flow.stage === 'adm-addadmin') {
      flows.delete(chatId);
      if (!isOwner(ctx.from?.id)) {
        return ctx.reply('🚫 Добавлять админов может только владелец бота.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      const n = Number(t.replace(/[^\d]/g, ''));
      if (!n || n < 1000) {
        return ctx.reply('Нужен числовой Telegram ID (например 123456789). Ещё раз или /cancel.', {
          reply_markup: adminKeyboard(ctx.from.id),
        });
      }
      db.addAdmin(n, 'admin', ctx.from.id);
      notifyAdmin(`👥 Новый админ добавлен: <code>${n}</code> (кем: ${ctx.from.id})`);
      return ctx.reply(`✅ Админ <code>${n}</code> добавлен.`, {
        parse_mode: 'HTML',
        reply_markup: adminKeyboard(ctx.from.id),
      });
    }

    if (flow.stage === 'adm-acc') {
      flows.delete(chatId);
      if (!isOwner(ctx.from?.id)) {
        return ctx.reply('🚫 Менять аккаунт комиссии может только владелец бота.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      if (!/^[A-Za-z0-9_.\-]{2,50}$/.test(t)) {
        return ctx.reply('Кривой логин. Попробуй ещё: <логин> или /cancel', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      db.setSetting('commission_account', t);
      notifyAdmin(`🏦 Комиссия теперь уходит на @${t}`);
      return ctx.reply(`✅ Аккаунт комиссии: @${t}`, { reply_markup: adminKeyboard(ctx.from.id) });
    }

    if (flow.stage === 'adm-amt') {
      flows.delete(chatId);
      if (!isOwner(ctx.from?.id)) {
        return ctx.reply('🚫 Менять сумму комиссии может только владелец бота.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      const n = Number(t.replace(/[^\d]/g, ''));
      if (!n || n <= 0 || n > 1e9) {
        return ctx.reply('Нужен нормальное число (например 10000).', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      db.setSetting('commission_amount', n);
      notifyAdmin(`💰 Сумма комиссии теперь ${fmt(n)} / день / аккаунт`);
      return ctx.reply(`✅ Сумма комиссии: ${fmt(n)}`, { reply_markup: adminKeyboard(ctx.from.id) });
    }

    // -- рассылка: текст сообщения и подтверждение --
    if (flow.stage === 'bc-text') {
      flows.delete(chatId);
      return startBroadcast(ctx, t);
    }

    if (flow.stage === 'pw') {
      if (t.length < 3) return ctx.reply('Подозрительно короткий пароль. Ещё раз или /cancel.');
      const accId = flow.accId;
      const row = db.getAccountForUser(ctx.from.id, accId);
      if (!row) { flows.delete(chatId); return ctx.reply('🚫 Аккаунт не найден.', { reply_markup: MENU() }); }
      flows.delete(chatId);
      db.changePassword(accId, t);
      notifyAdmin(`🔑 Сменён пароль аккаунта @${row.username} (юзер ${ctx.from.id})`);
      if (row.status === S.STOPPED) {
        return ctx.reply(`✅ Пароль для <b>${esc(row.username)}</b> обновлён.\nЗапусти аккаунт: «Мои аккаунты» → ▶️.`, {
          parse_mode: 'HTML',
        });
      }
      // аккаунт жив - пересоздаём ферму и сразу логинимся с новым паролем
      await engine.stop(accId, false);
      engine.start(accId, null, { earlyLogin: true });
      return ctx.reply(`✅ Пароль для <b>${esc(row.username)}</b> обновлён.\nПробую войти с новым паролем - скоро пришлю капчу.`, {
        parse_mode: 'HTML',
      });
    }

    if (flow.stage === 'user') {
      if (!/^[A-Za-z0-9_.\-]{2,50}$/.test(t)) {
        return ctx.reply('Логин странноватый (буквы/цифры/._-). Ещё раз или /cancel.');
      }
      if (db.findAccountByUsername(t)) {
        return ctx.reply('🚫 Такой аккаунт уже есть в системе. Другой логин или /cancel.');
      }
      flow.login = t;
      flow.stage = 'pass';
      return ctx.reply(`🔐 Пароль для <b>${esc(t)}</b>: (или /cancel)`, { parse_mode: 'HTML' });
    }

    if (flow.stage === 'pass') {
      if (t.length < 3) return ctx.reply('Подозрительно короткий пароль. Ещё раз или /cancel.');
      const accId = db.addAccount(ctx.from.id, chatId, flow.login, t);
      flows.delete(chatId);
      if (accId == null) {
        return ctx.reply('🚫 Кто-то уже добавил такой аккаунт. /accounts', { reply_markup: MENU() });
      }
      await ctx.reply(`✅ <b>${esc(flow.login)}</b> добавлен.\n📋 Начинаю вход - скоро пришлю капчу.`, {
        parse_mode: 'HTML',
      });
      engine.start(accId, null, { earlyLogin: true });
      return;
    }

    return next();
  });

  // (заглушки «перехватить все сообщения» нет - в grammY необработанные апдейты
  // и так игнорируются, а обработчик без next() ломал бы команды ниже по цепочке)

  // -- админ-панель --
  // владелец видит и настройки комиссии; обычный админ - только просмотр/рассылку
  const adminKeyboard = (viewerId = 0) => {
    const owner = isOwner(viewerId);
    const nAdmins = adminIds().length;
    const kb = new InlineKeyboard();
    if (owner) {
      const acc = db.commissionAccount || 'не задан';
      const amt = db.commissionAmount || COMMISSION_AMOUNT_DEFAULT;
      kb.text(`🏦 Комиссия → @${acc}`, 'adm:setacc').row()
        .text(`💰 Сумма: ${fmt(amt)}`, 'adm:setamt').row();
    }
    kb.text('🧾 Последние переводы', 'adm:transfers').row()
      .text('📊 Все аккаунты', 'adm:stats').row()
      .text('📢 Рассылка', 'adm:broadcast')
      .text(`👥 Админы (${nAdmins})`, 'adm:admins');
    return kb;
  };

  function adminText() {
    const amt = db.commissionAmount || COMMISSION_AMOUNT_DEFAULT;
    const stat = db.transfersStat();
    return (
      '🛠 <b>Админ-панель</b>\n' +
      `Аккаунт комиссии: <b>@${esc(db.commissionAccount || 'не задан')}</b>\n` +
      `Сумма комиссии: <b>${fmt(amt)}</b> за день с аккаунта\n` +
      `Переводов: ${stat.count} на ${fmt(stat.sum)} 🪙\n` +
      `Аккаунтов в системе: ${db.allAccounts().length} (активных: ${db.activeAccountsCount()})\n` +
      `Юзеров в боте: ${db.usersCount()} · админов: ${adminIds().length}`
    );
  }

  bot.command('admin', (ctx) => {
    claimOwner(ctx);
    if (!isAdmin(ctx.from?.id)) {
      const hint = OWNER_ID
        ? `В .env задан OWNER_ID=${OWNER_ID} (или ADMIN_ID), а твой Telegram id: <code>${ctx.from?.id}</code>.`
        : 'Владелец не задан - попроси админа добавить тебя: /adminadd <твой id>.';
      return ctx.reply(`🚫 Только для админов.\n${hint}\nПоправь .env и перезапусти бота.`, { parse_mode: 'HTML' });
    }
    return ctx.reply(adminWhichText(ctx.from.id), { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });
  function adminWhichText(id) {
    const base = adminText();
    const role = isOwner(id) ? 'владелец' : 'админ';
    return `${base}\nМоя роль: <b>${role}</b>`;
  }

  // -- мульти-админка: /adminadd, /admindel, /admins (добавлять/удалять может только владелец) --
  bot.command('adminadd', (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.reply('🚫 Добавлять админов может только владелец бота.');
    const ids = (ctx.message.text.split(/\s+/).slice(1) || [])
      .map((x) => Number(x.replace(/[^\d]/g, '')))
      .filter((n) => n >= 1000);
    if (!ids.length) return ctx.reply('Формат: <code>/adminadd 123456789</code> (можно несколько через пробел).', { parse_mode: 'HTML' });
    const lines = [];
    for (const id of ids) {
      db.addAdmin(id, 'admin', ctx.from.id);
      notifyAdmin(`👥 Новый админ добавлен: <code>${id}</code> (кем: ${ctx.from.id})`);
      lines.push(`✅ <code>${id}</code> - добавлен`);
    }
    return ctx.reply(`👥 Админы обновлены:\n${lines.join('\n')}`, { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.command('admindel', (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.reply('🚫 Удалять админов может только владелец бота.');
    const ids = (ctx.message.text.split(/\s+/).slice(1) || [])
      .map((x) => Number(x.replace(/[^\d]/g, '')))
      .filter((n) => n >= 1000);
    if (!ids.length) return ctx.reply('Формат: <code>/admindel 123456789</code> (можно несколько через пробел).', { parse_mode: 'HTML' });
    const lines = [];
    for (const id of ids) {
      if (isOwner(id) && id === OWNER_ID) {
        lines.push(`🚫 <code>${id}</code> - владелец из .env, не удаляется через бота`);
        continue;
      }
      if (db.adminRole(id) === 'owner') {
        lines.push(`🚫 <code>${id}</code> - владелец (claim), через бота не удаляется`);
        continue;
      }
      if (!db.isAdmin(id)) {
        lines.push(`- <code>${id}</code> - и так не админ`);
        continue;
      }
      db.removeAdmin(id);
      lines.push(`🗑 <code>${id}</code> - убран`);
    }
    return ctx.reply(`👥 Админы обновлены:\n${lines.join('\n')}`, { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.command('admins', (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('🚫 Только для админов.');
    return ctx.reply(adminsText(), { parse_mode: 'HTML', reply_markup: adminsKeyboard(ctx.from.id) });
  });

  function adminsText() {
    let t = '👥 <b>Админы бота</b>\n\n';
    if (OWNER_ID) t += `👑 <b>Владелец (.env OWNER_ID)</b>: <code>${OWNER_ID}</code>\n`;
    const claim = db.allAdmins().find((a) => a.role === 'owner');
    if (claim && claim.tg_user_id !== OWNER_ID) t += `👑 <b>Владелец (claim)</b>: <code>${claim.tg_user_id}</code>\n`;
    for (const a of db.allAdmins().filter((x) => x.role !== 'owner')) {
      t += `• <code>${a.tg_user_id}</code>${a.added_by ? ` (добавил ${a.added_by})` : ''}\n`;
    }
    t += `\nВсего админов: <b>${adminIds().length}</b>`;
    return t;
  }
  function adminsKeyboard(viewerId) {
    const kb = new InlineKeyboard();
    if (isOwner(viewerId)) {
      kb.text('➕ Добавить админа', 'adm:addadmin');
      for (const a of db.allAdmins().filter((x) => x.role === 'admin')) {
        kb.row().text(`🗑 ${a.tg_user_id}`, `admdel:${a.tg_user_id}`);
      }
      kb.row();
    }
    kb.text('⬅️ Назад', 'adm:panel');
    return kb;
  }

  // -- рассылка /broadcast --
  bot.command('broadcast', (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('🚫 Только для админов.');
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (arg) return startBroadcast(ctx, arg);
    flows.set(ctx.chat.id, { stage: 'bc-text' });
    return ctx.reply(
      '📢 Что разослать всем юзерам бота?\n\n' +
        'Можно HTML: <code>&lt;b&gt;жирный&lt;/b&gt;</code>, <code>&lt;i&gt;курсив&lt;/i&gt;</code>, <code>&lt;a href="..."&gt;ссылка&lt;/a&gt;</code>.\n' +
        '(/cancel - отмена)',
      { parse_mode: 'HTML' }
    );
  });

  async function startBroadcast(ctx, text) {
    const targets = db.broadcastTargets();
    if (!targets.length) return ctx.reply('Бот пустой - рассылать некому.', { reply_markup: adminKeyboard(ctx.from.id) });
    flows.set(ctx.chat.id, { stage: 'bc-confirm', bcText: text });
    await ctx.reply(`📢 <b>Предпросмотр рассылки</b> (получателей: ${targets.length}):\n\n${esc(text).slice(0, 3500)}`, {
      parse_mode: 'HTML',
    });
    return ctx.reply('Отправляем?', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Отправить всем', 'bc:yes')
        .text('❌ Отмена', 'bc:no'),
    });
  }

  async function runBroadcast(notifyChat, text) {
    const targets = db.broadcastTargets();
    let sent = 0, failed = 0;
    const parseErr = /pars|entit|can't parse entities/i;
    for (const chatId of targets) {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        sent++;
      } catch (e) {
        const msg = String(e?.message || e);
        if (parseErr.test(msg)) {
          // HTML не понравился Telegram - пробуем тот же текст как plain text
          try { await bot.api.sendMessage(chatId, text); sent++; } catch { failed++; }
        } else {
          failed++; // юзер заблокировал бота / чат недоступен
        }
      }
      await sleep(BROADCAST_DELAY_MS); // ~18 msg/s < лимита Telegram 30 msg/s
    }
    const report = `📢 Рассылка завершена.\nПолучателей: ${targets.length}\n✅ доставлено: ${sent}\n❌ не доставлено: ${failed}`;
    console.log(`[bot] broadcast: ${sent}/${targets.length} ok`);
    notifyUser(notifyChat, report);
    return { sent, failed, total: targets.length };
  }

  bot.callbackQuery('adm:broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'bc-text' });
    await ctx.reply(
      '📢 Что разослать всем юзерам бота?\n\n' +
        'Можно HTML: <code>&lt;b&gt;жирный&lt;/b&gt;</code>, <code>&lt;i&gt;курсив&lt;/i&gt;</code>.\n' +
        '(/cancel - отмена)',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('adm:addadmin', async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'adm-addadmin' });
    await ctx.reply('👥 Telegram ID нового админа (например 123456789): (или /cancel)');
  });

  bot.callbackQuery(/^admdel:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery().catch(() => {});
    db.removeAdmin(id);
    notifyAdmin(`👥 Админ убран: <code>${id}</code> (кем: ${ctx.from.id})`);
    await ctx.reply(`🗑 <code>${id}</code> - убран из админов.`, {
      parse_mode: 'HTML',
      reply_markup: adminsKeyboard(ctx.from.id),
    });
  });

  bot.callbackQuery('bc:yes', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    const flow = flows.get(ctx.chat.id);
    if (flow?.stage !== 'bc-confirm' || !flow.bcText) {
      await ctx.answerCallbackQuery('Нечего отправлять - сначала /broadcast').catch(() => {});
      return;
    }
    flows.delete(ctx.chat.id);
    await ctx.answerCallbackQuery('Запускаю рассылку...').catch(() => {});
    const msg = await ctx.reply('⏳ Рассылка пошла...', { reply_markup: new InlineKeyboard() });
    await runBroadcast(ctx.chat.id, flow.bcText);
    try { await bot.api.deleteMessage(ctx.chat.id, msg.message_id); } catch {}
    await ctx.reply('Готово.', { reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('bc:no', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    flows.delete(ctx.chat.id);
    await ctx.answerCallbackQuery('Отменено').catch(() => {});
    await ctx.reply('❌ Рассылка отменена.', { reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('adm:setacc', async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'adm-acc' });
    await ctx.reply('🏦 Логин аккаунта-приёмника комиссии: (или /cancel)');
  });

  bot.callbackQuery('adm:setamt', async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'adm-amt' });
    await ctx.reply('💰 Сумма комиссии за день с одного аккаунта (например 10000): (или /cancel)');
  });

  bot.callbackQuery('adm:transfers', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    const rows = db.lastTransfers(10);
    let t = '🧾 <b>Переводы (последние 10)</b>\n\n';
    if (!rows.length) t += '- пусто -';
    for (const r of rows) {
      const d = new Date(r.ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
      t += `${d} · <b>${esc(r.from_user)}</b> → @${esc(r.to_user)}: ${fmt(r.amount)} ` +
        (r.status === 'ok' ? '✅' : `❌ <i>${esc(r.note)}</i>`) + '\n';
    }
    await ctx.reply(t, { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('adm:stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    const rows = db.allAccounts();
    let t = '📊 <b>Все аккаунты</b>\n\n';
    if (!rows.length) t += '- пусто -';
    const kb = new InlineKeyboard();
    for (const r of rows) t += accText(r) + '\n\n';
    kb.text('🧾 Переводы', 'adm:transfers').row().text('⬅️ Назад', 'adm:panel');
    await ctx.reply(t, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery('adm:admins', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(adminsText(), { parse_mode: 'HTML', reply_markup: adminsKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('adm:panel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(adminWhichText(ctx.from.id), { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  // -- кнопка «🔑 Перелогиниться» (шлёт её engine, код relog:<accountId>) --
  // ВАЖНО: не await-им логин внутри обработчика! grammY обрабатывает апдейты
  // последовательно, а логин ждёт код капчи следующим апдейтом - иначе дедлок.
  bot.callbackQuery(/^relog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    const busy = engine.farms.get(id)?.loggingNow;
    await ctx.answerCallbackQuery(busy ? 'Вход уже идёт, жди капчу.' : 'Запрашиваю страницу входа...').catch(() => {});
    engine.relogin(id)
      .then((r) => {
        // успех уже присылает сам engine («✅ вход выполнен») - не дублируем
        if (!r.ok && r.why === 'аккаунт не запущен') {
          notifyUser(row.tg_chat_id, `⏸ ${row.username}: аккаунт остановлен - сначала запусти его («Мои аккаунты» → ▶️).`);
        } else if (!r.ok && r.why !== 'вход уже идёт') {
          notifyUser(row.tg_chat_id, `❌ ${row.username}: ${r.why}. Нажми «🔑 Перелогиниться» ещё раз.`);
        }
      })
      .catch((e) => {
        console.error('[relog]', e?.stack || e);
        notifyUser(row.tg_chat_id, `❌ ${row.username}: внутренняя ошибка входа. Нажми кнопку ещё раз.`);
      });
  });

  // кнопка «🔄 Другая капча»: последнюю ждущую капчу перезапрашиваем на новую картинку
  bot.callbackQuery(/^capregen:(-?\d+)$/, async (ctx) => {
    const chatId = Number(ctx.match[1]);
    if (ctx.from.id !== chatId) return ctx.answerCallbackQuery('🚫');
    const list = captchaWaiters.get(chatId);
    if (!list?.length) return ctx.answerCallbackQuery('Капча не запрошена.');
    await ctx.answerCallbackQuery('Шлю новую капчу...').catch(() => {});
    list[list.length - 1].resolve('__regen__');
  });

  // неизвестные кнопки
  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery().catch(() => {}));

  // ошибки бота
  bot.catch((err) => console.error('[bot]', err.error?.stack || err.error || err));

  return { bot, notifyUser, notifyAdmin, notifySend, adminIds };
}
