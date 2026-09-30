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

- **Piano** (vista iniziale): un **giro** per cliente. Il giro parte dalla data che scegli tu (**Inizio giro**) e comprende i primi N post pubblicati o programmati su Pubblie da quella data, dove N sono i video da contratto. Per ogni cliente: quanti ne sono pronti su N, quanti mancano, prossima uscita scoperta, entro quando consegnarla, data dell'ultimo video del giro. I post oltre N sono già del giro successivo. Il giro nuovo non parte da solo: a giro completo si apre il cliente e si preme **Nuovo giro** (o si cambia la data a mano).
  - **Montati**: il montatore apre il cliente e aggiorna con − / + quanti video del giro ha montato. Non si può scendere sotto i post già su Pubblie (un post pubblicato o programmato è per forza montato). La differenza tra montati e post su Pubblie compare in arancione: sono video pronti che vanno ancora programmati. **Nuovo giro** azzera i montati.
  - **Da girare**: interruttore per i clienti il cui materiale non è ancora stato girato (nel dettaglio del Piano e in Clienti). Finché è acceso il cliente non ha scadenze né uscite da montare e non conta nei video da montare.
- **Mese**: calendario con i post reali di Pubblie e le uscite del giro ancora da montare (bordo rosso tratteggiato).
- **Scadenze**: la lista di cose da fare del montatore, raggruppata per giorno di consegna.
- **Clienti**: video/mese da contratto, giorni di uscita, anticipo, Nascondi/Mostra.
- **Registro**: storico delle registrazioni manuali.

### Come si calcolano i giorni di uscita
- Dal contratto: uscite a settimana ≈ video/mese × 12 / 52 (12 → Lun·Mer·Ven, 8 → Mar·Ven, 24 → Lun–Sab…).
- Le uscite da montare partono dal giorno dopo l'ultimo post pronto su Pubblie (mai prima di oggi) e seguono quei giorni finché il giro arriva al numero del contratto.
- Si possono scegliere i giorni a mano cliccandoli in Clienti; **Auto** torna al calcolo dal contratto.
- Contano i post pubblicati e programmati. I post rimossi dai social non contano.

## Dove gira

- **Database**: progetto Supabase `fvl-montaggio` (eu-west-1), separato da `fvl-core`. Separato apposta: su `fvl-core` quasi ogni tabella è aperta a qualsiasi utente loggato, e il montatore avrebbe visto tutto il CRM.
- **Accesso**: niente login. Si entra con un link segreto `https://montaggio.fvlmedia.it/?k=<chiave>`: il browser si ricorda la chiave e la toglie dalla barra degli indirizzi. Senza chiave valida il database non restituisce nulla. Le chiavi valide stanno nella tabella `planner_access`.
- **Hosting**: progetto Vercel `fvl-montaggio`, dominio `montaggio.fvlmedia.it` (serve un CNAME verso `cname.vercel-dns.com` sul DNS di fvlmedia.it).
- **Clienti**: importati da `fvl-core.crm_clienti` (collegati con `crm_id`). `videos_per_month` viene dal campo `video_da_fare` del CRM.

### Sincronizzazione con Pubblie (zero token)
La Edge Function `sync-pubblie` (codice in `supabase/functions/sync-pubblie/`) chiama direttamente il server MCP di Pubblie (`https://pubblie.io/mcp`), senza nessun modello AI, e aggiorna la tabella `publications`: ultimi 7 giorni e prossimi 60.
- **Collegamento, una volta sola**: vista Mese → **Collega Pubblie** → login su Pubblie → autorizzi. L'app si registra da sola su Pubblie (OAuth con registrazione dinamica) e la funzione rinnova l'accesso con il refresh token. I token stanno in `pubblie_oauth`, mai esposta all'app.
- Parte da sola ogni 2 ore (job `pg_cron` "sync-pubblie") e dal pulsante **Aggiorna da Pubblie**.
- I post vengono abbinati ai clienti tramite `clients.pubblie_accounts`. I canali senza cliente compaiono in Clienti, da collegare con un menu.
- L'esito di ogni giro è in `sync_runs`. Se Pubblie revoca l'accesso, basta premere di nuovo **Collega Pubblie**.

### Cosa si modifica dall'app (senza toccare il database)
- **Clienti**: nome, colore, giorni di uscita, anticipo, pulsante Nascondi/Mostra.
- **Dettagli** di un cliente: video al mese da contratto, account Pubblie collegati (uno per riga), video già pronti, grezzi, note.
- **Canali Pubblie non collegati**: riquadro in cima a Clienti, si assegnano a un cliente con un menu.

### Ripubblicare dopo una modifica
Fai push sul branch e crea un deployment Vercel dal commit (progetto `fvl-montaggio`, root directory `planner-montaggio`, nessun passaggio di build).

## Sviluppo locale

```bash
cd planner-montaggio && python3 -m http.server 8000
```
