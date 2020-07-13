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
    let picture: string | null = event.request.userAttributes.picture;
    try {
        picture = JSON.parse(picture).data.url;
    } catch (err) {
        // Not a JSON structure (e.g. Google)
    }
    if (typeof picture !== 'string' || !/^https?:\/\//.test(picture)) {
        picture = null;
    }
    event.response = {
        claimsOverrideDetails: {
            claimsToAddOrOverride: {
                picture,
            },
        },
    };
    return event;
};
