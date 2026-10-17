# Synology Surveillance Station

Vos caméras Synology Surveillance Station dans Gladys, en local, par l’API
Web de DSM (sans cloud, sans QuickConnect) :

- chaque caméra devient une caméra Gladys : son image sur le tableau de bord,
  un instantané tout frais en vue en direct ;
- son état **activé** dans Surveillance Station (un interrupteur) ;
- un détecteur de **mouvement** par caméra, et le déclencheur de scène
  **Mouvement détecté** (événements de détection de mouvement ou d’analyse
  vidéo) ;
- le **mode Maison** de Surveillance Station : lu, commandé, et le
  déclencheur de scène **Mode Maison changé**.

> **Jamais testé sur un vrai NAS.** Cette première version a été écrite
> d’après le guide de l’API Web de Surveillance Station et d’après
> py-synologydsm-api, et testée seulement contre un faux NAS. Merci de
> signaler ce qui fonctionne ou non sur le forum de Gladys.

Intégration non officielle, sans lien avec Synology.

## Avant de commencer : un compte dédié

1. Dans DSM, **Panneau de configuration → Utilisateur et groupe**, créez un
   utilisateur `gladys` avec un mot de passe solide. Il n’a besoin d’aucun
   dossier partagé ni d’aucune autre application.
2. Dans **Surveillance Station → Paramètres de privilèges** (profils de
   privilèges), donnez-lui un profil :
   - la lecture seule (spectateur) suffit pour les images, les détecteurs de
     mouvement et la lecture du mode Maison ;
   - pour activer / désactiver les caméras ou commander le mode Maison depuis
     Gladys, le profil doit le permettre (gestionnaire, ou un profil
     personnalisé avec ces droits).
3. **Validation en deux étapes** : préférez un compte sans (le compte sert à
   une machine). Si DSM l’impose à tous les comptes, voyez plus bas.

## Configuration

- **Adresse du NAS** : `https://192.168.1.10:5001` (ou
  `http://192.168.1.10:5000` ; en http le mot de passe traverse votre réseau
  en clair). Une adresse seule est lue en https sur le port 5001.
- **Identifiant / mot de passe DSM** : le compte dédié. Le mot de passe est
  gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à votre
  NAS.
- **Code de validation en deux étapes** : seulement pour un compte avec
  validation en deux étapes. Saisissez un code à 6 chiffres tout frais de
  votre application d’authentification et enregistrez aussitôt (un code dure
  30 s). Gladys garde ensuite le jeton d’appareil donné par DSM (dans son
  volume `/data`) et n’a plus besoin de code. Un code n’est envoyé qu’une
  fois.
- **Accepter le certificat auto-signé du NAS** : désactivé par défaut, le
  certificat doit alors venir d’une autorité reconnue (Let’s Encrypt…).
  Activé : le certificat vu à la première connexion est accepté et mémorisé ;
  un autre ensuite est refusé (quelqu’un se fait peut-être passer pour votre
  NAS) tant que vous n’appuyez pas sur **Faire confiance au nouveau
  certificat**.
- **Autoriser la réduction de la surveillance** : désactivé par défaut (voir
  Commandes).
- **Lecture des mouvements** : de 5 s à 1 min (10 s par défaut).
- **Rafraîchissement de l’image du tableau de bord** : aucun, ou de 30 s à
  10 min.

Ouvrez ensuite l’onglet **Découverte** et créez les caméras et l’appareil
Surveillance Station (mode Maison) voulus.

## Commandes

- **Activer une caméra** et **quitter le mode Maison** ajoutent de la
  surveillance : toujours possibles.
- **Désactiver une caméra** et **activer le mode Maison** réduisent la
  surveillance (moins d’enregistrements, moins d’alertes) : Gladys refuse les
  deux tant que vous ne cochez pas **Autoriser la réduction de la
  surveillance**. Laissez-le décoché si une scène ou un autre utilisateur ne
  doit pas pouvoir aveugler vos caméras.
- Les commandes passent une par une. Juste avant d’agir, Gladys relit l’état
  sur le NAS : s’il n’y arrive pas, rien n’est envoyé ; si le NAS est déjà
  dans l’état demandé, rien n’est envoyé non plus. Quand le NAS répond trop
  lentement (plus de 3,5 s), rien n’est envoyé et Gladys affiche un échec
  (jamais d’action après un échec affiché).

## Mouvements

Surveillance Station ne pousse pas ses événements vers Gladys : Gladys lit
les événements récents au rythme choisi. Un événement de mouvement ou
d’analyse vidéo déclenche une fois **Mouvement détecté** (avec la caméra, son
nom et `motion` ou `analytics`) et active le détecteur de mouvement de la
caméra ; le détecteur revient à « pas de mouvement » une fois l’événement
terminé. Les événements déjà présents au démarrage ne déclenchent rien. La
détection de mouvement doit être activée sur la caméra dans Surveillance
Station (paramètres de détection d’événements).

## Problèmes de connexion

- **Mauvais mot de passe, compte verrouillé ou expiré** : Gladys ne réessaie
  pas seul, car DSM bloque une adresse après quelques échecs de connexion
  (blocage automatique). Corrigez la configuration et enregistrez-la, ou
  appuyez sur **Tester la connexion**.
- **NAS injoignable** : nouvel essai après 30 s, puis jusqu’à toutes les
  10 min ; les caméras sont affichées injoignables en attendant.
- **Session perdue** (DSM redémarré, session expirée) : renouvelée une fois,
  jamais en boucle.

## Limites

- Un seul NAS par intégration. Les images sont des instantanés (pas de flux
  vidéo en direct dans Gladys) ; un instantané plus lourd que ce que Gladys
  accepte (150 Ko, 60 Ko pour l’image du tableau de bord) est redemandé dans
  le profil « faible bande passante », sinon il n’est pas affiché.
- Le détecteur de mouvement et le déclencheur ont un retard d’au plus le
  rythme choisi.
- Seuls les événements de mouvement (raison 2) et d’analyse vidéo (7) comptent
  comme mouvement ; les autres enregistrements (continu, manuel, entrée
  d’alarme) sont ignorés. Ces codes viennent du guide de l’API et ne sont pas
  encore vérifiés.
- Non testé avec Surveillance Station sur un VisualStation Synology, des
  serveurs d’enregistrement CMS ou C2 Surveillance.
