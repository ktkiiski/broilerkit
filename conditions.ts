import { firestore } from 'firebase';
import { ValidationError } from './errors';
import { Field } from './fields';

export interface Condition<R, _W> {
  validate(field: Field<R>, value?: R): R | undefined | firestore.FieldValue;
  getSecurityRule(key: string, field: Field<R>): string[];
}

export function setTo<S>(requiredValue: S): Condition<S, 'excluded'> {
  return {
    validate(field, value) {
      if (typeof value === 'undefined') {
        return requiredValue;
      }
      if (value !== requiredValue) {
        throw new ValidationError(`Value ${field.encode(value)} is not equal to ${field.encode(requiredValue)}`);
      }
      return field.validate(value);
    },
    getSecurityRule(key, field) {
      const keyJS = JSON.stringify(key);
      const valueJS = JSON.stringify(field.serialize(requiredValue));
      const reference = `request.resource.data[${keyJS}]`;
      return [
        `${reference} == ${valueJS}`,
        ...field.getRuleConditions(reference),
      ];
    },
  };
}

export function setAuthUserId(): Condition<string, 'excluded'> {
  return {
    validate(_) {
      // TODO
      throw new Error('Not implemented');
    },
    getSecurityRule(key, field) {
      const keyJS = JSON.stringify(key);
      const reference = `request.resource.data[${keyJS}]`;
      return [
        `${reference} == request.auth.uid`,
        ...field.getRuleConditions(reference),
      ];
    },
  };
}

export function matchAuthUserId(): Condition<string, 'excluded'> {
  return {
    validate(_) {
      // TODO
      throw new Error('Not implemented');
    },
    getSecurityRule(key) {
      const keyJS = JSON.stringify(key);
      const reference = `resource.data[${keyJS}]`;
      return [
        `${reference} == request.auth.uid`,
      ];
    },
  };
}

export function setGenerated<S>(callable: () => S): Condition<S, 'excluded'> {
  return {
    validate(field) {
      return field.validate(callable());
    },
    getSecurityRule(key, field) {
      const keyJS = JSON.stringify(key);
      const reference = `request.resource.data[${keyJS}]`;
      return field.getRuleConditions(reference);
    },
  };
}

export function required<S>(): Condition<S, 'required'> {
  return {
    validate(field, value) {
      if (typeof value === 'undefined') {
        throw new ValidationError(`Value is required`);
      }
      return field.validate(value);
    },
    getSecurityRule(key, field) {
      const keyJS = JSON.stringify(key);
      const reference = `request.resource.data[${keyJS}]`;
      return [
        `${keyJS} in request.resource.data`,
        ...field.getRuleConditions(reference),
      ];
    },
  };
}

export function optional<S>(): Condition<S, 'optional'> {
  return {
    validate(field, value) {
      if (typeof value === 'undefined') {
        return undefined;
      }
      return field.validate(value);
    },
    getSecurityRule(key, field) {
      const keyJS = JSON.stringify(key);
      const reference = `request.resource.data[${keyJS}]`;
      const baseCondition = `!(${keyJS} in request.resource.data)`;
      const fieldConditions = field.getRuleConditions(reference);
      if (!fieldConditions.length) {
        return [baseCondition];
      }
      return [`${baseCondition} || (${fieldConditions.join(' && ')})`];
    },
  };
}

export function disallowSet<S>(): Condition<S, 'excluded'> {
  return {
    validate(_, value) {
      if (typeof value === 'undefined') {
        return undefined;
      }
      throw new ValidationError(`Key cannot be written`);
    },
    getSecurityRule(key) {
      const keyJS = JSON.stringify(key);
      return [`!(${keyJS} in request.resource.data)`];
    },
  };
}

export function setTimestamp(): Condition<firestore.Timestamp, 'excluded'> {
  return {
    validate(_, value) {
      if (typeof value !== 'undefined') {
        throw new ValidationError(`Custom values are not allowed`);
      }
      return firestore.FieldValue.serverTimestamp();
    },
    getSecurityRule(key, field) {
      const keyJS = JSON.stringify(key);
      const reference = `request.resource.data[${keyJS}]`;
      return [
        ...field.getRuleConditions(reference),
        `${reference}.toMillis() == request.time.toMillis()`,
      ];
    },
  };
}
