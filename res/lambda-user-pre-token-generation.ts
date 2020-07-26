interface PreTokenGenerationTriggerEvent {
    request: {
        userAttributes: {
            [attr: string]: string;
        };
    };
    response: {
        claimsOverrideDetails: {
            claimsToAddOrOverride: {
                [key: string]: string | null;
            };
        };
    };
}

export const handler = async (event: PreTokenGenerationTriggerEvent): Promise<PreTokenGenerationTriggerEvent> => {
    let pic: string | null = event.request.userAttributes.picture;
    try {
        pic = JSON.parse(pic).data.url;
    } catch (err) {
        // Not a JSON structure (e.g. Google)
    }
    if (typeof pic !== 'string' || !/^https?:\/\//.test(pic)) {
        pic = null;
    }
    // eslint-disable-next-line no-param-reassign
    event.response = {
        claimsOverrideDetails: {
            claimsToAddOrOverride: {
                picture: pic,
            },
        },
    };
    return event;
};
