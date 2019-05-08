import { Action } from './models';
import { isNotNully } from './utils/compare';
import { indent } from './utils/strings';

type ActionName = 'read' | 'create' | 'update' | 'delete';
type Actions = Record<ActionName, Action[]>;
type Matches = Record<string, Actions>;
const actionNames = ['read', 'create', 'update', 'delete'] as ActionName[];

/**
 * Generates contents of a firestore.rules file
 * according to the given operations.
 * @param actions Array of operations to allow
 */
export function buildFirestoreRules(actions: Action[]): string {
  // Group actions by collection, and then by the action name
  const matches: Matches = {};
  for (const action of actions) {
    const matchString = getMatchString(action.collection);
    const matchActions = matches[matchString] || {
      read: [],
      create: [],
      update: [],
      delete: [],
    };
    matches[matchString] = matchActions;
    const ruleSets = matchActions[action.actionName] || [];
    matchActions[action.actionName] = ruleSets;
    ruleSets.push(action);
  }
  return compileCollectionMatches(matches);
}

function compileCollectionMatches(rules: Matches) {
  const lines: string[] = [];
  Object.keys(rules).forEach((matchString) => lines.push(
    `  match ${matchString} {`,
    ...indentLines(compileActions(rules[matchString]), 4),
    `  }`,
  ));
  return `service cloud.firestore {
  match /databases/{database}/documents {
${lines.join('\n')}
  }
}`;
}

function compileActions(actions: Actions) {
  return actionNames.map(
    (actionName) => indent(compileAction(actionName, actions[actionName]), 2),
  );
}

function compileAction(actionName: string, ruleSets: Action[]) {
  if (!ruleSets.length) {
    // No actions -> never allow!
    return `allow ${actionName}: if false;`;
  }
  const conditionSets = ruleSets.map((rules) => compileConditions(rules));
  if (conditionSets.some((rules) => !rules.length)) {
    // At least one action has no conditions at all -> always allow!
    return `allow ${actionName};`;
  }
  // Array of `(xx && yyy && zzz)` strings with indentations
  const lines = conditionSets.map((rules) => `(\n    ${rules.join(' &&\n    ')}\n)`);
  return `allow ${actionName}:\n  if ${lines.join('\n  || ')}\n;`;
}

function compileConditions(action: Action): string[] {
  const { properties, collection, auth } = action;
  const rules = [];
  if (auth !== 'none') {
    // Requires authentication
    rules.push(`request.auth.uid != null`);
  }
  // TODO: auth === 'admin'
  // Validation for resource fields
  const { fields } = collection;
  Object.keys(properties).forEach((key) => {
    const field = fields[key];
    const rule = properties[key];
    if (rule != null) {
      rules.push(...rule.getSecurityRule(key, field));
    }
  });
  return rules;
}

function indentLines(lines: string[], indentation: number) {
  return lines.map((line) => indent(line, indentation));
}

function getMatchString({ name, parent }: Action['collection']): string {
  const matchString = `/${name}/{${name}Id}`;
  return parent ? `${getMatchString(parent)}${matchString}` : matchString;
}

/*
service cloud.firestore {
  match /databases/{database}/documents {
    match /chats/{chatId} {
      allow read;
      allow create:
        if request.auth.uid != null
        && request.resource.data.creatorId == request.auth.uid
        && request.resource.data.messageCount == 0
        && request.resource.data.participantCount == 0
        && request.resource.data.createdAt.toMillis() == request.time.toMillis()
      ;
      allow delete: if resource.data.creatorId == request.auth.uid;

      match /messages/{messageId} {
        allow read;
        allow create:
          if request.auth.uid != null
          && request.resource.data.senderId == request.auth.uid
          && request.resource.data.createdAt.toMillis() == request.time.toMillis()
        ;
        allow delete: if resource.data.senderId == request.auth.uid;
      }
      match /participants/{userId} {
        allow read;
        allow create: if request.auth.uid == userId;
        allow update: if request.auth.uid == userId;
      }
    }
  }
}
*/
