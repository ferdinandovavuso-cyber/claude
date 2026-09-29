# Planner Montaggio

Calendario condiviso tra te e il montatore. Per ogni cliente mostra fino a quando le uscite sono coperte, quando va consegnato il prossimo video e quanti ne servono per le prossime due settimane.

## Come ragiona

Ogni cliente ha:
- **video pubblicati per giorno della settimana** (es. Lun/Mer/Ven = 1). **Senza questo dato il sistema non funziona.**
- **anticipo**: quanti giorni prima dell'uscita il video deve essere pronto (default 2). Se la consegna cade nel weekend, viene anticipata al venerdì.
- **punto di partenza**: una data, i video già pronti a quella data e i grezzi già in mano al montatore.

Partendo da quella data, il sistema scala un video montato per ogni uscita in calendario. La prima uscita che resta scoperta è il **buco**: la **consegna** è il buco meno l'anticipo.

Il montatore registra **"+ Ho montato N"**. Tu registri **"+ Grezzi consegnati N"** (il blocco da 12/24). Se i grezzi rimasti non bastano per le prossime due settimane, la scheda lo segnala: vuol dire che il collo di bottiglia è il girato, non il montaggio.

## Viste

- **Scadenze**: la lista di cose da fare del montatore, raggruppata per giorno di consegna, con il carico di video di ogni giorno.
- **Calendario**: clienti × prossimi 28 giorni. Verde = uscita coperta, rosso = scoperta, bordo arancione = giorno di consegna.
- **Clienti**: pianificazione delle uscite di ogni cliente.
- **Registro**: storico delle registrazioni, per correggere gli errori.

## Messa online (su un sottodominio di FVL Media)

1. **Supabase**: crea un progetto e nel SQL Editor esegui `schema.sql`. Da *Authentication → Users* crea due utenti (tu e il montatore) con email e password. Da *Authentication → Providers → Email* disattiva le registrazioni pubbliche (*Allow new users to sign up*).
2. **Config**: in `config.js` incolla `SUPABASE_URL` e la chiave `anon` (da *Project Settings → API*). La chiave anon può stare nel frontend: l'accesso ai dati è protetto dalle policy RLS e richiede il login.
3. **Hosting**: pubblica la cartella `planner-montaggio/` su Netlify o Vercel come sito statico: non serve nessun passaggio di build.
4. **Dominio**: aggiungi il sottodominio (es. `montaggio.fvlmedia.it`) nel progetto di hosting e crea il record CNAME che ti indica il provider.

Senza `config.js` compilato l'app gira in **modalità demo**: i dati restano solo nel browser. Serve per provarla, non per lavorarci in due.

## Sviluppo locale

```bash
cd planner-montaggio && python3 -m http.server 8000
```
