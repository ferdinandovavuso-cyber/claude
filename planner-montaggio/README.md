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

## Dove gira

- **Database**: progetto Supabase `fvl-montaggio` (eu-west-1), separato da `fvl-core`. Separato apposta: su `fvl-core` quasi ogni tabella è aperta a qualsiasi utente loggato, e il montatore avrebbe visto tutto il CRM.
- **Accesso**: login con email e password. Oltre al login serve che l'email sia in `team_members`: chi si registra da solo senza essere in lista vede 0 righe.
- **Hosting**: progetto Vercel `fvl-montaggio`, dominio `montaggio.fvlmedia.it` (serve un CNAME verso `cname.vercel-dns.com` sul DNS di fvlmedia.it).

### Aggiungere una persona
1. Supabase → progetto `fvl-montaggio` → *Authentication → Users → Add user* (email e password, spunta *Auto Confirm*).
2. SQL Editor: `insert into public.team_members (email) values ('sua@email.it');`

### Ripubblicare dopo una modifica
Carica di nuovo i file di questa cartella sul progetto Vercel `fvl-montaggio`: non c'è nessun passaggio di build.

## Sviluppo locale

```bash
cd planner-montaggio && python3 -m http.server 8000
```
