//
//  main.m
//  GeckoViewSandbox
//
//  Created by James Willcox on 10/15/15.
//  Copyright © 2015 Mozilla. All rights reserved.
//

#import <UIKit/UIKit.h>
#import <GeckoKit/GeckoKit.h>
#import "AppDelegate.h"

int main(int argc, char * argv[]) {
    [GeckoThread startup];
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
    }
}
