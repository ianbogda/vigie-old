import type { ViewHelpSpec } from '../types';

export const VIEW_HELP: Record<string, ViewHelpSpec> = {
  'Analyse financière': {
    purpose:"Comprendre la situation financière de l’établissement, sa structure et sa trajectoire à partir des données consolidées dans Vigie.",
    reading:["Commencer par les KPI FdR, BFdR, trésorerie, résultat et CAF/IAF.","Lire ensuite les évolutions pluriannuelles et les créances/dettes qui peuvent expliquer la situation.","Descendre vers l’analyse du FdR lorsque la situation nécessite une instruction plus détaillée."],
    sources:[{name:'YFDR',format:'CSV',freshness:'À actualiser après clôture ou nouvelle situation disponible.'},{name:'EBLC',format:'XLSX',freshness:'Utiliser une situation datée et identifier l’exercice.'},{name:'YCONSDEP / YCONSREC',format:'XLSX' },'YBALAC','YBALAF',{name:'Compte 5151',format:'CSV',freshness:'Une alimentation régulière est nécessaire pour lire la dynamique.'}],
    vigilance:["Comparer des données de même date avant de rapprocher FdR, BFdR et trésorerie.","Un indicateur isolé ne suffit pas à qualifier la soutenabilité financière.","Les données de l’exercice courant sont provisoires tant que le compte financier n’est pas arrêté."],
    nextActions:["Ouvrir l’analyse détaillée du FdR si une marge financière doit être appréciée.","Consulter Clients ou Fournisseurs lorsque le BFdR ou les balances âgées expliquent la situation.","Actualiser les imports lorsque les dates de référence sont trop anciennes."],
    notes:["Les pas-à-pas OP@LE seront ajoutés à mesure de leur validation terrain."], indicators:['FDR','BFDR','TRESORERIE_NETTE','JOURS_FDR','CAF_IAF']
  },
  'Budget': {
    purpose:"Suivre la construction et l’exécution budgétaires de l’établissement, puis repérer les écarts qui méritent une analyse.",
    reading:["Lire d’abord les masses budgétées et réalisées.","Comparer ensuite les taux d’exécution par service, domaine et activité.","Examiner enfin les points d’attention et revenir aux données sources si une valeur doit être expliquée."],
    sources:[{name:'Budget OP@LE',format:'.lis ou .xlsx',freshness:'À réimporter après une modification budgétaire ou lorsqu’une nouvelle situation est nécessaire.'},{name:'EBLC',format:'XLSX'}],
    vigilance:["Un taux d’exécution n’est pas une cible calendaire normative.","Le rythme dépend du calendrier réel des opérations, engagements et recettes.","Toujours distinguer budget, engagé, réalisé, en cours et disponible."],
    nextActions:["Développer le service ou domaine concerné.","Comparer dépenses et recettes du même périmètre.","Consulter les données sources OP@LE en cas d’écart à expliquer."],
    notes:["Le gabarit d’aide est prêt ; le parcours OP@LE reste à documenter."], indicators:['TAUX_EXEC_DEPENSES','TAUX_EXEC_RECETTES']
  },
  'Dépenses': {
    purpose:"Piloter l’exécution des dépenses et identifier les opérations, comptes ou fournisseurs qui nécessitent un contrôle.",
    reading:["Commencer par les montants de l’exercice et la dynamique récente.","Lire les dettes échues et anciennes pour apprécier les décaissements en attente.","Examiner ensuite les comptes et fournisseurs qui expliquent les concentrations ou accélérations."],
    sources:[{name:'YCONSDEP',format:'XLSX',freshness:'À actualiser selon le rythme de supervision souhaité.'},'YBALAF'],
    vigilance:["Une accélération récente n’est pas automatiquement une anomalie : elle peut correspondre au calendrier normal des achats.","Une concentration fournisseur est un signal d’examen, pas une irrégularité en elle-même."],
    nextActions:["Ouvrir l’EPLE concerné depuis la vue agence.","Contrôler les comptes et tiers à l’origine du signal.","Actualiser YBALAF pour vérifier les dettes arrivées à échéance."],
    notes:["Le parcours d’export OP@LE reste à documenter."], indicators:['TAUX_EXEC_DEPENSES','CONCENTRATION_FOURNISSEUR','DETTES_EXIGIBLES']
  },
  'Recettes': {
    purpose:"Piloter l’exécution des recettes et repérer les créances dont le recouvrement ou l’ancienneté nécessite une attention.",
    reading:["Lire les recettes de l’exercice et leur dynamique récente.","Examiner les créances à recouvrer et le stock ancien.","Mettre enfin le TnR en regard du volume de recettes et de l’ancienneté YBALAC."],
    sources:[{name:'YCONSREC',format:'XLSX'},'YBALAC',{name:'EBLC',format:'XLSX',note:'Nécessaire au TnR.'}],
    vigilance:["Le TnR n’est pas 100 % moins un taux d’encaissement calculé sur une autre assiette.","Le stock > 121 jours n’est pas assimilable à des créances > 1 an."],
    nextActions:["Ouvrir Clients pour identifier les débiteurs et pièces concernés.","Vérifier la date de YBALAC et l’exercice de l’EBLC utilisé pour le TnR."],
    notes:["Le parcours d’export OP@LE reste à documenter."], indicators:['TAUX_EXEC_RECETTES','TNR','STOCK_ANCIEN_CLIENTS']
  },
  'Trésorerie': {
    purpose:"Suivre la trajectoire de trésorerie et apprécier sa soutenabilité sans isoler le seul solde du compte 5151.",
    reading:["Commencer par l’autonomie observée et sa variation récente.","Lire ensuite FdR/BFdR et la trésorerie après dettes exigibles pour comprendre la structure.","Examiner enfin TnR, créances anciennes et dettes exigibles pour apprécier la qualité de la liquidité."],
    sources:[{name:'Écritures du compte 5151',format:'CSV',freshness:'Alimentation régulière recommandée ; Vigie ne simule pas les périodes absentes.'},'YBALAC','YBALAF',{name:'Analyse financière',format:'FdR / BFdR',note:'Vérifier la date de référence.'},{name:'EBLC',format:'XLSX',note:'Utilisée notamment pour le TnR.'}],
    vigilance:["Le 5151 observé n’est pas automatiquement égal à la trésorerie nette comptable.","FdR/BFdR et 5151 peuvent relever de dates différentes.","Les seuils 30 / 42 / 65 jours sont des repères de pilotage Vigie, pas des seuils réglementaires."],
    nextActions:["Ouvrir l’EPLE depuis une bulle ou le tableau de surveillance.","Consulter Clients si les créances anciennes ou le TnR appellent un contrôle.","Consulter Fournisseurs si des dettes exigibles peuvent expliquer une trésorerie temporairement élevée."],
    notes:["Le parcours d’export OP@LE reste à documenter."], indicators:['AUTONOMIE_TRESORERIE','TRESO_APRES_DETTES_EXIGIBLES','TNR','VARIATION_5151_30J','FDR_BFDR']
  },
  'Clients': {
    purpose:"Analyser les créances clients, leur ancienneté et les situations nécessitant une attention particulière.",
    reading:["Lire l’encours total puis la part échue et ancienne.","Repérer les EPLE ou tiers concentrant le stock ancien.","Descendre ensuite jusqu’aux pièces pour préparer le contrôle ou l’action de recouvrement."],
    sources:['YBALAC',{name:'EBLC',format:'XLSX',note:'Nécessaire au TnR lorsque celui-ci est affiché.'}],
    vigilance:["La balance âgée décrit un stock à une date donnée ; sa fraîcheur conditionne l’analyse.","La tranche > 121 jours ne signifie pas > 1 an.","Un encours ancien doit être rapproché des actions de recouvrement et de la nature de la créance."],
    nextActions:["Ouvrir le détail par tiers et pièce.","Actualiser YBALAC si la situation n’est plus représentative.","Rapprocher le stock ancien du TnR et de la vue Trésorerie."],
    indicators:['STOCK_ANCIEN_CLIENTS','PART_STOCK_ANCIEN','TNR']
  },
  'Fournisseurs': {
    purpose:"Analyser les dettes fournisseurs, leur ancienneté et les décaissements susceptibles d’affecter rapidement la trésorerie.",
    reading:["Lire les dettes totales puis la part échue et ancienne.","Repérer les EPLE ou fournisseurs concentrant les montants exigibles.","Descendre ensuite jusqu’aux pièces concernées."],
    sources:['YBALAF'],
    vigilance:["Une dette échue n’est pas automatiquement une anomalie ; sa cause doit être vérifiée.","Une balance âgée ancienne peut sous-estimer ou surestimer la pression de décaissement actuelle."],
    nextActions:["Ouvrir le détail par tiers et pièce.","Actualiser YBALAF si nécessaire.","Rapprocher les dettes exigibles de la vue Trésorerie."],
    indicators:['DETTES_EXIGIBLES']
  },
  'Comptabilité générale': {
    purpose:"Examiner les comptes des classes 1 à 8, les signaux comptables et les pièces non soldées afin de cibler les contrôles.",
    reading:["Commencer par les KPI de la vue agence ou la synthèse de l’EPLE.","Repérer le compte ou la famille de comptes concernés.","Descendre ensuite vers les pièces puis les écritures qui expliquent le signal."],
    sources:[{name:'Données comptables OP@LE — classes 1 à 8',format:'CSV',freshness:'À actualiser pour disposer d’une situation comptable représentative.'},'YGPIE1'],
    vigilance:["Un solde inhabituel ou une pièce ouverte est un signal de contrôle, pas une anomalie démontrée.","Le sens du solde dépend de la nature du compte.","YGPIE1 décrit les pièces non soldées à la date de l’export."],
    nextActions:["Ouvrir le compte signalé.","Contrôler les pièces non soldées et leur ancienneté.","Descendre jusqu’aux écritures avant de conclure sur la situation."],
    notes:["YGPIE1 alimente les pièces non soldées et les rapprochements."], indicators:['SOLDE_COMPTE','PIECES_NON_SOLDEES']
  },
  'Maîtrise des risques': {
    purpose:"Mettre les observations Vigie en regard du contexte PCIF afin de prioriser les contrôles et l’accompagnement, sans modifier le diagnostic PCIF.",
    reading:["Lire d’abord la couverture du diagnostic avant le niveau de maîtrise.","Examiner ensuite les risques majeurs, actions en retard et domaines d’attention.","Utiliser enfin les cohérences PCIF × Vigie pour choisir les points à approfondir dans PCIF Académie."],
    sources:[{name:'PCIF Académie',format:'Synthèse synchronisée',freshness:'La campagne et sa date de synchronisation doivent être identifiées.'},{name:'Données des vues métier Vigie',format:'Sources consolidées'}],
    vigilance:["Une maîtrise élevée sur une faible couverture est peu représentative.","Vigie n’altère ni la cotation des risques ni le plan d’action PCIF.","Une incohérence PCIF × Vigie sert à prioriser un examen ; elle ne démontre pas à elle seule une défaillance de maîtrise."],
    nextActions:["Sélectionner l’EPLE ou le domaine concerné.","Ouvrir PCIF Académie pour examiner le diagnostic et le plan d’action.","Actualiser la synchronisation si la campagne affichée n’est plus la campagne de référence."],
    indicators:['COUVERTURE_PCIF','MAITRISE_PCIF','RISQUES_MAJEURS_PCIF']
  },
};
