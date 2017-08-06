/**
 * When importing a PNG file, the imported value is the URL of the image.
 */
declare module "*.png" {
    const imageUrl: string;
    export = imageUrl;
}

/**
 * When importing a JPG file, the imported value is the URL of the image.
 */
declare module "*.jpg" {
    const imageUrl: string;
    export = imageUrl;
}

/**
 * When importing a GIF file, the imported value is the URL of the image.
 */
declare module "*.gif" {
    const imageUrl: string;
    export = imageUrl;
}

/**
 * When importing a TMPL file (expected to contain HTML), then the imported
 * value is a the string contents of the file.
 */
declare module "*.tmpl" {
    const content: string;
    export = content;
}

/**
 * When importing a PUG file, the imported value is the template function.
 */
declare module "*.pug" {
    const imageUrl: (...args: any[]) => any; // TODO!
    export = imageUrl;
}
