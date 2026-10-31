#include <stdio.h>

int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    int sum = a + b;
    if (sum >= 0) {
        if (sum >= 10) {
            if (sum >= 100) {
                if (sum >= 1000) {
                    if (sum >= 10000) {
                        if (sum >= 100000) {
                            printf("%d\n", sum);
                        } else {
                            printf("%d\n", sum);
                        }
                    } else {
                        printf("%d\n", sum);
                    }
                } else {
                    printf("%d\n", sum);
                }
            } else {
                printf("%d\n", sum);
            }
        } else {
            printf("%d\n", sum);
        }
    } else {
        printf("%d\n", sum);
    }
    return 0;
}
