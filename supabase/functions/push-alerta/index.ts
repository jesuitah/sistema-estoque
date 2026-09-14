// NOTIFICAÇÕES NO CELULAR — o app "Alertas" do iPhone.
//
// Nasceu do fim de semana de 12-14/09/2026: a sessão da KMP caiu no sábado às 12:45, o
// robô escreveu o aviso certinho numa página do sistema, e ninguém viu até segunda de
// manhã. 18 anúncios com estoque ficaram dois dias sem vender. Aviso que não chega em
// ninguém não é aviso.
//
// AÇÕES:
//   inscrever      -> guarda o celular que tocou em "Ativar notificações" no app
//   teste          -> manda uma notificação de teste pra todos os celulares
//   vigiar         -> roda de 5 em 5 minutos (pg_cron) e avisa o que mudou
//
// E os "OK" do app — só o que destrava o sistema, nada de usar o sistema pelo celular
// (pedido do Matheus em 14/09/2026: "só quero no app o que for pra dar ok no sistema
// pra ele seguir rodando"):
//   dispensar       -> (sem uso no app desde 14/09/2026: "ok, já vi" só escondia o
//                      aviso, não resolvia nada — botão que finge ser ação saiu da tela)
//   tentar_de_novo  -> devolve uma tarefa que falhou pra fila
//   liberar_sessao  -> "já reconectei no PC": tira a loja da pausa na hora
//   retomar_robo    -> desfaz o "parar robô"
//
// Passam por aqui, e não direto no banco pelo celular, pra que o app só consiga fazer
// ESTAS quatro coisas — e nenhuma outra.
//
// POR QUE O VIGIA ESTÁ AQUI E NÃO NO ROBÔ: o robô não consegue avisar da própria morte.
// Se o PC desliga ou o processo cai, quem percebe tem que estar do lado de fora — e esta
// função roda no servidor do Supabase, que não depende do PC do Matheus.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Tocar na notificação abre o app de alertas, não o sistema inteiro: quem recebe o
// aviso quer ver o que precisa de ok, não navegar por abas no celular.
const SITE = "https://jesuitah.github.io/sistema-estoque/alertas/";

// Quanto tempo sem batida do robô até considerar que ele caiu. Ele bate ponto a cada
// poucos segundos; uma varredura de promoções longa ainda bate a cada 25 anúncios.
// 15 minutos é folga suficiente pra não dar alarme falso num trabalho demorado.
const ROBO_OFFLINE_MIN = 15;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });

let configurado = false;
async function configurar() {
  if (configurado) return;
  const { data, error } = await sb.from("push_config").select("*").eq("id", 1).single();
  if (error || !data) throw new Error("push_config vazio — faltam as chaves VAPID");
  webpush.setVapidDetails(data.contato, data.vapid_publica, data.vapid_privada);
  configurado = true;
}

// Manda pra TODOS os celulares inscritos. Celular que desinstalou o app ou revogou a
// permissão responde 404/410 — esse sai da lista sozinho, pra não ficar tentando pra
// sempre um aparelho que não existe mais.
async function enviarParaTodos(titulo: string, mensagem: string, tag?: string) {
  await configurar();
  const { data: inscricoes } = await sb.from("push_inscricoes").select("*");
  const carga = JSON.stringify({ titulo, mensagem, url: SITE, tag: tag ?? null });

  let enviados = 0, removidos = 0;
  const falhas: string[] = [];
  for (const i of inscricoes ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } },
        carga,
        { TTL: 60 * 60 * 24, urgency: "high" },
      );
      enviados++;
      await sb.from("push_inscricoes").update({ ultimo_ok: new Date().toISOString() }).eq("id", i.id);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await sb.from("push_inscricoes").delete().eq("id", i.id);
        removidos++;
      } else {
        falhas.push(`${i.aparelho ?? i.id}: ${status ?? ""} ${String((e as Error).message ?? e).slice(0, 120)}`);
      }
    }
  }
  return { inscritos: (inscricoes ?? []).length, enviados, removidos, falhas };
}

// Já avisou disto? Marca e devolve se é a primeira vez.
async function primeiraVez(chave: string) {
  const { data } = await sb.from("push_avisados").select("chave").eq("chave", chave).maybeSingle();
  if (data) return false;
  await sb.from("push_avisados").insert({ chave });
  return true;
}
async function esquecer(chave: string) {
  const { data } = await sb.from("push_avisados").delete().eq("chave", chave).select("chave");
  return !!(data && data.length);   // true = existia, ou seja, tinha sido avisado
}

function horaSP(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit",
  });
}

async function vigiar() {
  const enviados: string[] = [];

  // 1) O ROBÔ ESTÁ VIVO?
  const { data: st } = await sb.from("robo_status").select("ultima_batida").eq("id", 1).single();
  const minutos = st?.ultima_batida
    ? (Date.now() - new Date(st.ultima_batida).getTime()) / 60000 : 99999;

  if (minutos > ROBO_OFFLINE_MIN) {
    if (await primeiraVez("robo_offline")) {
      await enviarParaTodos(
        "🔴 Robô desligado",
        `Sem sinal desde ${st?.ultima_batida ? horaSP(st.ultima_batida) : "—"}. ` +
        "Veja se o PC está ligado. As tarefas esperam na fila, nada se perde.",
        "robo_offline");
      enviados.push("robo_offline");
    }
  } else if (await esquecer("robo_offline")) {
    // Só avisa que voltou se tinha avisado que caiu — senão seria ruído.
    await enviarParaTodos("🟢 Robô de volta", "Voltou a trabalhar. A fila está andando de novo.", "robo_offline");
    enviados.push("robo_voltou");
  }

  // 2) LOJA DESCONECTADA — o único outro caso que depende de uma pessoa.
  //
  // A REGRA DE TUDO O QUE NOTIFICA: SÓ O QUE ALGUÉM PRECISA FAZER.
  //
  // Até 14/09/2026 esta função notificava qualquer alerta grave do vigia do robô. Em
  // uma manhã o celular do Matheus apitou duas vezes por nada: "tarefa desligar_flex
  // falhou" e "1 anúncio sem estoque parado no Full". Nos dois o robô já estava cuidando.
  // A pergunta dele resume a regra: "isso realmente deveria aparecer pra mim? não é algo
  // que precise de uma atitude minha".
  //
  // Passando cada aviso por esse filtro, sobram DOIS: robô desligado (alguém olha o PC)
  // e loja desconectada (alguém reconecta a conta). O resto — anúncio preso no Full,
  // patrulha que tropeçou, tarefa que falhou — é o robô tentando de novo, ou é assunto
  // pra investigar no código. Ninguém resolve isso pelo celular, então não apita.
  //
  // Lido de robo_sessoes, e não dos alertas: é a fonte direta, sem depender do vigia do
  // robô ter rodado.
  const { data: sessoes } = await sb.from("robo_sessoes").select("conta, caida_desde");
  for (const s of sessoes ?? []) {
    // A chave carrega QUANDO caiu: se a mesma loja cair de novo outro dia, é um aviso
    // novo, e não "já avisei disso" por causa da queda anterior.
    const prefixo = `sessao:${s.conta}:`;
    if (s.caida_desde) {
      if (await primeiraVez(prefixo + s.caida_desde)) {
        await enviarParaTodos(
          `🔌 ${s.conta} desconectada`,
          `A sessão da ${s.conta} caiu. Precisa de alguém no PC pra entrar de novo na conta ` +
          `pelo Chrome do robô. As outras lojas seguem normais.`,
          `sessao_${s.conta}`);
        enviados.push(prefixo + "caiu");
      }
    } else {
      const { data: antigas } = await sb.from("push_avisados")
        .delete().like("chave", prefixo + "%").select("chave");
      if (antigas && antigas.length) {
        // Só avisa que voltou se tinha avisado que caiu. A mesma tag substitui a
        // notificação de queda em vez de empilhar outra.
        await enviarParaTodos(`🟢 ${s.conta} conectada de novo`, "Tudo certo, a loja voltou a trabalhar.", `sessao_${s.conta}`);
        enviados.push(prefixo + "voltou");
      }
    }
  }

  return { robo_minutos_sem_sinal: Math.round(minutos), enviados };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);

  try {
    const corpo = await req.json().catch(() => ({}));
    const acao = corpo.acao;

    if (acao === "inscrever") {
      const i = corpo.inscricao;
      if (!i?.endpoint || !i?.keys?.p256dh || !i?.keys?.auth) {
        return json({ erro: "inscrição incompleta" }, 400);
      }
      const { error } = await sb.from("push_inscricoes").upsert({
        endpoint: i.endpoint, p256dh: i.keys.p256dh, auth: i.keys.auth,
        aparelho: String(corpo.aparelho ?? "").slice(0, 120) || null,
      }, { onConflict: "endpoint" });
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true });
    }

    if (acao === "teste") {
      const r = await enviarParaTodos(
        "🔔 Teste do Sistema de Estoque",
        "Se você está lendo isto no celular, os avisos vão chegar aqui. Pode fechar.",
        "teste");
      return json({ ok: true, ...r });
    }

    if (acao === "vigiar") {
      return json({ ok: true, ...(await vigiar()) });
    }

    // ── Os "OK" do app ─────────────────────────────────────────────────────────

    if (acao === "dispensar") {
      const id = Number(corpo.id);
      if (!id) return json({ erro: "faltou o alerta" }, 400);
      const { error } = await sb.from("robo_alertas")
        .update({ dispensado_em: new Date().toISOString() }).eq("id", id);
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true });
    }

    if (acao === "tentar_de_novo") {
      const id = Number(corpo.id);
      if (!id) return json({ erro: "faltou a tarefa" }, 400);
      // Só devolve pra fila o que falhou. Mexer em tarefa pendente ou rodando pelo
      // celular poderia disparar a mesma ação duas vezes.
      const { data, error } = await sb.from("ml_tarefas_robo")
        .update({ status: "pendente", iniciado_em: null, concluido_em: null, erro: null,
                  criado_em: new Date().toISOString() })
        .eq("id", id).eq("status", "falhou").select("id");
      if (error) return json({ erro: error.message }, 500);
      if (!data || !data.length) return json({ erro: "essa tarefa não está mais como falhou" }, 409);
      return json({ ok: true });
    }

    if (acao === "liberar_sessao") {
      const conta = String(corpo.conta ?? "");
      if (!["KMP", "ERP", "LTS"].includes(conta)) return json({ erro: "loja inválida" }, 400);
      // NÃO marca a sessão como de pé — isso quem prova é o robô, abrindo o navegador.
      // Só antecipa a próxima tentativa pra agora. Se a pessoa disse "já reconectei" e
      // não tinha reconectado, o robô tenta, cai no login de novo e volta a pausar
      // sozinho: o botão nunca consegue fingir que está tudo bem.
      const { error } = await sb.from("robo_sessoes")
        .update({ proxima_tentativa: new Date().toISOString(), atualizado_em: new Date().toISOString() })
        .eq("conta", conta);
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true });
    }

    if (acao === "retomar_robo") {
      const { error } = await sb.from("robo_status").update({ parar: false }).eq("id", 1);
      if (error) return json({ erro: error.message }, 500);
      return json({ ok: true });
    }

    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message ?? e) }, 500);
  }
});
