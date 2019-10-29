// tslint:disable:no-console
import { CognitoIdentityServiceProvider } from 'aws-sdk';

interface PreSignupTriggerEvent {
    userName: string;
    request: {
        userAttributes: {
            [attr: string]: string;
        };
    };
}

export const handler = async (event: PreSignupTriggerEvent) => {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) {
      throw new Error('Missing USER_POOL_ID environment variable');
  }
  const idp = new CognitoIdentityServiceProvider({ apiVersion: '2016-04-18' });
  const email = event.request.userAttributes.email;
  // TODO: Ensure that the email is verified?
  if (!email) {
    return event;
  }
  const [srcProviderName, srcProviderUserId] = event.userName.split('_');
  if (!srcProviderUserId || (srcProviderName !== 'Google' && srcProviderName !== 'Facebook')) {
    return event;
  }
  const existingUsersRequest = idp.listUsers({
    UserPoolId: userPoolId,
    Filter: `email=${JSON.stringify(email)}`,
    Limit: 1,
  });
  const usersResponse = await existingUsersRequest.promise();
  for (const user of usersResponse.Users as CognitoIdentityServiceProvider.UserType[]) {
    const username = user.Username;
    if (!username) {
      continue;
    }
    console.log(`Found an existing user ${username} with the same email address`);
    const [providerName, userId] = username.split('_');
    if (userId && (providerName === 'Google' || providerName === 'Facebook') && providerName !== srcProviderName) {
      console.log(`Linking an existing ${providerName} user ${userId} with the ${srcProviderName} user ${srcProviderUserId}`);
      const request = idp.adminLinkProviderForUser({
        UserPoolId: userPoolId,
        // Existing user
        DestinationUser: {
            ProviderAttributeValue: userId, // e.g. "0987654321",
            ProviderName: providerName, // e.g. "Google"
        },
        SourceUser: {
            ProviderAttributeName: 'Cognito_Subject',
            ProviderAttributeValue: srcProviderUserId, // e.g. "1234567890",
            ProviderName: srcProviderName, // e.g. "Facebook"
        },
      });
      await request.promise();
    }
  }
  return event;
};
