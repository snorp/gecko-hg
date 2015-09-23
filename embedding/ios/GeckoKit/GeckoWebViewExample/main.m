//
//  main.m
//  GeckoWebViewExample
//
//  Created by James Willcox on 10/2/15.
//  Copyright © 2015 Mozilla. All rights reserved.
//

#import <UIKit/UIKit.h>
#import <GeckoKit/GeckoKit.h>
#import "AppDelegate.h"

int main(int argc, char * argv[]) {
    // Get a head start on starting Gecko. This is optional, but could help
    // apps that know they're going to need a GeckoWebView
    [GeckoThread startup];
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
    }
}
